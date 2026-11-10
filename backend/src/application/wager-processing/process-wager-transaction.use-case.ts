import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Money } from '../../domain/money.js';
import {
  DuplicateLedgerReversalError,
  InvalidWalletLedgerEntryError,
  RollbackWouldCauseNegativeBalanceError,
  WalletLedgerDirection,
  WalletLedgerEntry,
} from '../../domain/wallet-ledger-entry.js';
import { InsufficientBalanceError, Wallet } from '../../domain/wallet.js';
import {
  WagerRejectionCode,
  WagerTransaction,
  WagerTransactionStatus,
  WagerTransactionType,
  type WagerTransactionSnapshot,
} from '../../domain/wager-transaction.js';
import {
  type InboxMessage,
  WALLET_TRANSACTION_UNIT_OF_WORK,
  type WalletTransactionContext,
  type WalletTransactionUnitOfWorkPort,
} from '../ports/persistence.repositories.js';
import {
  createIntegrationEvent,
  WalletBalanceChanged,
  type IntegrationEventType,
} from '../events/integration-event.js';
import { RequestContext } from '../../observability/request-context.js';
import { IdempotencyConflictError } from './idempotency-conflict.error.js';

export const PENDING_REFERENCE_MAX_RETRIES = 5;
export const PENDING_REFERENCE_BASE_DELAY_MS = 1_000;

/** Processa uma operação financeira isolada sob transação e lock da wallet. */
@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(WALLET_TRANSACTION_UNIT_OF_WORK)
    private readonly unitOfWork: WalletTransactionUnitOfWorkPort,
  ) {}

  /**
   * Persiste a operação uma vez; reenvios iguais retornam o registro já salvo.
   */
  async execute(input: WagerTransaction): Promise<WagerTransaction> {
    const result = await this.process(input);
    if (!result) {
      throw new Error('Uma mensagem HTTP não pode ser deduplicada pela inbox.');
    }
    return result;
  }

  executeFromQueue(
    input: WagerTransaction,
    inboxMessage: InboxMessage,
  ): Promise<WagerTransaction | null> {
    return this.process(input, inboxMessage);
  }

  private async process(
    input: WagerTransaction,
    inboxMessage?: InboxMessage,
  ): Promise<WagerTransaction | null> {
    const original = input.toSnapshot();

    if (original.status !== WagerTransactionStatus.PENDING) {
      throw new Error('Somente uma transação PENDING pode ser processada.');
    }

    // A API calcula o hash dos campos de negócio para não confiar em hash recebido.
    const snapshot = {
      ...original,
      payloadHash: this.hashBusinessPayload(original),
    };

    return this.unitOfWork.withIdempotencyAndWalletLock(
      snapshot.walletId,
      snapshot.idempotencyKey,
      async (context) => {
        if (context.duplicateInboxMessage) return null;

        const existing = context.existingIdempotentTransaction;

        if (existing) {
          if (existing.payloadHash !== snapshot.payloadHash) {
            throw new IdempotencyConflictError();
          }

          return existing;
        }

        if (!context.wallet) {
          throw new Error('Wallet ausente após adquirir o lock transacional.');
        }

        return this.processInsideTransaction(snapshot, {
          ...context,
          wallet: context.wallet,
        });
      },
      inboxMessage,
    );
  }

  async retryPendingReference(
    idempotencyKey: string,
    now = new Date(),
  ): Promise<WagerTransaction | null> {
    return this.unitOfWork.withPendingReferenceLock(
      idempotencyKey,
      async (context) => {
        const pending = context.existingIdempotentTransaction;

        if (
          !pending ||
          pending.status !== WagerTransactionStatus.PENDING_REFERENCE
        ) {
          return pending;
        }

        if (
          pending.referenceNextAttemptAt &&
          pending.referenceNextAttemptAt.getTime() > now.getTime()
        ) {
          return pending;
        }

        if (!context.wallet) {
          throw new Error(
            'Wallet ausente ao reprocessar uma referência pendente.',
          );
        }

        const reference = pending.referenceTransactionId
          ? await context.transactions.findById(pending.referenceTransactionId)
          : pending.referenceExternalTransactionId
            ? await context.transactions.findByProviderAndExternalId(
                pending.providerId,
                pending.referenceExternalTransactionId,
              )
            : null;

        if (!reference) {
          const attempts = pending.referenceAttempts + 1;
          const expired = attempts >= PENDING_REFERENCE_MAX_RETRIES;

          const nextAttemptAt = expired
            ? null
            : new Date(
                now.getTime() + PENDING_REFERENCE_BASE_DELAY_MS * 2 ** attempts,
              );

          pending.recordReferenceRetry(nextAttemptAt);

          if (expired) {
            pending.reject(WagerRejectionCode.REFERENCE_NOT_FOUND);

            this.recordOutboxEvent(context, {
              eventId: randomUUID(),
              aggregateId: pending.id,
              eventType: 'WagerTransactionRejected',
              data: {
                transactionId: pending.id,
                providerId: pending.providerId,
                externalTransactionId: pending.externalTransactionId,
                kind: pending.kind,
                failureCode: WagerRejectionCode.REFERENCE_NOT_FOUND,
                balance: context.wallet.balance.toJSON().amount,
              },
              occurredAt: now,
            });

            this.recordOutboxEvent(context, {
              eventId: randomUUID(),
              aggregateId: pending.id,
              eventType: 'WagerTransactionReferenceExpired',
              data: {
                transactionId: pending.id,
                failureCode: WagerRejectionCode.REFERENCE_NOT_FOUND,
                attempts,
              },
              occurredAt: now,
            });
          }

          await context.transactions.update(pending);
          return pending;
        }

        pending.resumeAfterReference();

        return this.processInsideTransaction(
          pending.toSnapshot(),
          { ...context, wallet: context.wallet },
          pending,
        );
      },
    );
  }

  /** Gera SHA-256 determinístico somente com campos que alteram o significado financeiro. */
  private hashBusinessPayload(snapshot: WagerTransactionSnapshot): string {
    const payload = {
      amount: snapshot.amount.toJSON().amount,
      currency: snapshot.currency,
      externalTransactionId: snapshot.externalTransactionId,
      gameId: snapshot.gameId,
      kind: snapshot.kind,
      playerId: snapshot.playerId,
      providerId: snapshot.providerId,
      referenceExternalTransactionId:
        snapshot.referenceExternalTransactionId ?? null,
      referenceTransactionId: snapshot.referenceTransactionId ?? null,
      roundId: snapshot.roundId,
      walletId: snapshot.walletId,
    };

    return createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  /** Executa as regras após adquirir o lock e usando apenas dados da mesma transação SQL. */
  private async processInsideTransaction(
    snapshot: WagerTransactionSnapshot,
    context: WalletTransactionContext,
    existing?: WagerTransaction,
  ): Promise<WagerTransaction> {
    const { wallet, wallets, transactions, ledgerEntries } = context;

    if (!wallet) {
      throw new Error('Wallet ausente no processamento de uma nova operação.');
    }

    if (
      wallet.playerId !== snapshot.playerId ||
      wallet.currency !== snapshot.currency
    ) {
      return this.reject(
        snapshot,
        context,
        WagerRejectionCode.INVALID_REFERENCE,
        wallet.balance,
        existing,
      );
    }

    const processed = existing ?? WagerTransaction.rehydrate(snapshot);

    processed.markProcessed();

    const balanceBefore = wallet.balance;

    let entry: WalletLedgerEntry | null = null;
    let balanceChanged = false;

    switch (snapshot.kind) {
      case WagerTransactionType.BET:
        try {
          wallet.debit(snapshot.amount);
        } catch (error) {
          if (error instanceof InsufficientBalanceError) {
            return this.reject(
              snapshot,
              context,
              WagerRejectionCode.INSUFFICIENT_BALANCE,
              wallet.balance,
              existing,
            );
          }

          throw error;
        }

        entry = WalletLedgerEntry.createForTransaction({
          id: randomUUID(),
          transaction: processed,
          balanceBefore,
        });

        balanceChanged = true;
        break;

      case WagerTransactionType.WIN:
      case WagerTransactionType.OPENING:
        wallet.credit(snapshot.amount);

        entry = WalletLedgerEntry.createForTransaction({
          id: randomUUID(),
          transaction: processed,
          balanceBefore,
        });

        balanceChanged = true;
        break;

      case WagerTransactionType.LOSS:
        // LOSS registra a transação, mas não altera saldo nem cria lançamento.
        break;

      case WagerTransactionType.REFUND:
      case WagerTransactionType.ROLLBACK: {
        const reversal = await this.createReversal(
          snapshot,
          processed,
          wallet,
          context,
          balanceBefore,
          existing,
        );

        if (reversal instanceof WagerTransaction) return reversal;

        entry = reversal;

        if (entry.direction === WalletLedgerDirection.CREDIT) {
          wallet.credit(entry.amount);
        } else {
          wallet.debit(entry.amount);
        }

        balanceChanged = true;
        break;
      }
    }

    // Persiste a carteira somente quando houve alteração de saldo.
    if (balanceChanged) {
      await wallets.update(wallet);
    }

    // O lançamento é inserido na mesma unidade de trabalho/transação.
    if (entry) {
      ledgerEntries.insert(entry);
    }

    if (processed.responseBalance === null) {
      processed.recordResponseBalance(wallet.balance);
    }

    if (existing) {
      await transactions.update(processed);
    } else {
      transactions.insert(processed);
    }

    // Evento de integração para toda transação processada, inclusive LOSS.
    this.recordOutboxEvent(context, {
      eventId: randomUUID(),
      aggregateId: processed.id,
      eventType: 'WagerTransactionProcessed',
      data: {
        transactionId: processed.id,
        providerId: processed.providerId,
        externalTransactionId: processed.externalTransactionId,
        kind: processed.kind,
        amount: processed.amount.toJSON().amount,
        currency: processed.currency,
        balance: wallet.balance.toJSON().amount,
      },
      occurredAt: new Date(),
    });

    // Evento de saldo somente quando houve alteração financeira.
    if (balanceChanged) {
      if (!entry) {
        throw new Error(
          'Invariante violada: saldo alterado sem lançamento no ledger.',
        );
      }

      // A classe concreta monta o envelope e serializa os valores monetários.
      const balanceChangedEvent = WalletBalanceChanged.from(
        wallet,
        entry,
        {
          correlationId:
            RequestContext.currentCorrelationId ?? wallet.id,
          causationId: processed.id,
        },
      );

      context.outboxEvents.insert(balanceChangedEvent);
    }

    return processed;
  }

  /** Resolve referências e constrói o lançamento compensatório, ou registra o motivo terminal. */
  private async createReversal(
    snapshot: WagerTransactionSnapshot,
    processed: WagerTransaction,
    wallet: Wallet,
    context: WalletTransactionContext,
    balanceBefore: Money,
    existing?: WagerTransaction,
  ): Promise<WalletLedgerEntry | WagerTransaction> {
    const { transactions, ledgerEntries } = context;

    if (
      !snapshot.referenceTransactionId &&
      !snapshot.referenceExternalTransactionId
    ) {
      return this.reject(
        snapshot,
        context,
        WagerRejectionCode.INVALID_REFERENCE,
        balanceBefore,
        existing,
      );
    }

    const original = snapshot.referenceTransactionId
      ? await transactions.findById(snapshot.referenceTransactionId)
      : await transactions.findByProviderAndExternalId(
          snapshot.providerId,
          snapshot.referenceExternalTransactionId!,
        );

    if (!original) {
      const pending = WagerTransaction.rehydrate(snapshot);

      pending.markPendingReference(
        new Date(Date.now() + PENDING_REFERENCE_BASE_DELAY_MS),
      );

      pending.recordResponseBalance(balanceBefore);

      transactions.insert(pending);

      this.recordOutboxEvent(context, {
        eventId: randomUUID(),
        aggregateId: pending.id,
        eventType: 'WagerTransactionPendingReference',
        data: {
          transactionId: pending.id,
          providerId: pending.providerId,
          externalTransactionId: pending.externalTransactionId,
          referenceTransactionId: pending.referenceTransactionId,
          referenceExternalTransactionId:
            pending.referenceExternalTransactionId,
        },
        occurredAt: new Date(),
      });

      return pending;
    }

    const originalEntry = await ledgerEntries.findByTransactionId(original.id);

    if (!originalEntry) {
      return this.reject(
        snapshot,
        context,
        WagerRejectionCode.INVALID_REFERENCE,
        balanceBefore,
        existing,
      );
    }

    const existingReversal = await ledgerEntries.findReversalByTransactionId(
      original.id,
    );

    try {
      return WalletLedgerEntry.reverse({
        id: randomUUID(),
        transaction: processed,
        originalTransaction: original,
        originalEntry,
        balanceBefore,
        existingReversal,
      });
    } catch (error) {
      if (error instanceof RollbackWouldCauseNegativeBalanceError) {
        return this.reject(
          snapshot,
          context,
          error.code,
          balanceBefore,
          existing,
        );
      }

      if (
        error instanceof InvalidWalletLedgerEntryError ||
        error instanceof DuplicateLedgerReversalError
      ) {
        return this.reject(
          snapshot,
          context,
          WagerRejectionCode.INVALID_REFERENCE,
          balanceBefore,
          existing,
        );
      }

      throw error;
    }
  }

  /** Persiste uma rejeição auditável sem modificar saldo ou ledger. */
  private async reject(
    snapshot: WagerTransactionSnapshot,
    context: WalletTransactionContext,
    code: (typeof WagerRejectionCode)[keyof typeof WagerRejectionCode],
    responseBalance: Money,
    existing?: WagerTransaction,
  ): Promise<WagerTransaction> {
    const rejected = WagerTransaction.rehydrate(snapshot);

    rejected.reject(code);

    if (rejected.responseBalance === null) {
      rejected.recordResponseBalance(responseBalance);
    }

    if (existing) {
      await context.transactions.update(rejected);
    } else {
      context.transactions.insert(rejected);
    }

    this.recordOutboxEvent(context, {
      eventId: randomUUID(),
      aggregateId: rejected.id,
      eventType: 'WagerTransactionRejected',
      data: {
        transactionId: rejected.id,
        providerId: rejected.providerId,
        externalTransactionId: rejected.externalTransactionId,
        kind: rejected.kind,
        failureCode: rejected.failureCode,
        balance: responseBalance.toJSON().amount,
      },
      occurredAt: new Date(),
    });

    return rejected;
  }

  /**
   * Registra eventos comuns no Outbox usando as classes concretas.
   * WalletBalanceChanged é excluído porque exige dados do Wallet e do Ledger.
   */
  private recordOutboxEvent(
    context: WalletTransactionContext,
    event: {
      eventId: string;
      aggregateId: string;
      eventType: Exclude<IntegrationEventType, 'WalletBalanceChanged'>;
      data: Record<string, unknown>;
      occurredAt: Date;
    },
  ): void {
    const causationId =
      typeof event.data.transactionId === 'string'
        ? event.data.transactionId
        : event.aggregateId;

    context.outboxEvents.insert(
      createIntegrationEvent(event.eventType, {
        ...event,
        correlationId:
          RequestContext.currentCorrelationId ?? event.aggregateId,
        causationId,
      }),
    );
  }
}

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
  WALLET_TRANSACTION_UNIT_OF_WORK,
  type WalletTransactionContext,
  type WalletTransactionUnitOfWorkPort,
} from '../ports/persistence.repositories.js';
import { IdempotencyConflictError } from './idempotency-conflict.error.js';

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
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  /** Executa as regras após adquirir o lock e usando apenas dados da mesma transação SQL. */
  private async processInsideTransaction(
    snapshot: WagerTransactionSnapshot,
    context: WalletTransactionContext,
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
        transactions,
        WagerRejectionCode.INVALID_REFERENCE,
        wallet.balance,
      );
    }

    const processed = WagerTransaction.rehydrate(snapshot);
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
              transactions,
              WagerRejectionCode.INSUFFICIENT_BALANCE,
              wallet.balance,
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
        break;

      case WagerTransactionType.REFUND:
      case WagerTransactionType.ROLLBACK: {
        const reversal = await this.createReversal(
          snapshot,
          processed,
          wallet,
          context,
          balanceBefore,
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

    if (balanceChanged) await wallets.update(wallet);
    if (entry) ledgerEntries.insert(entry);
    processed.recordResponseBalance(wallet.balance);
    transactions.insert(processed);
    return processed;
  }

  /** Resolve referências e constrói o lançamento compensatório, ou registra o motivo terminal. */
  private async createReversal(
    snapshot: WagerTransactionSnapshot,
    processed: WagerTransaction,
    wallet: Wallet,
    context: WalletTransactionContext,
    balanceBefore: Money,
  ): Promise<WalletLedgerEntry | WagerTransaction> {
    const { transactions, ledgerEntries } = context;
    if (
      !snapshot.referenceTransactionId &&
      !snapshot.referenceExternalTransactionId
    ) {
      return this.reject(
        snapshot,
        transactions,
        WagerRejectionCode.INVALID_REFERENCE,
        balanceBefore,
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
      pending.markPendingReference();
      pending.recordResponseBalance(balanceBefore);
      transactions.insert(pending);
      return pending;
    }

    const originalEntry = await ledgerEntries.findByTransactionId(original.id);
    if (!originalEntry) {
      return this.reject(
        snapshot,
        transactions,
        WagerRejectionCode.INVALID_REFERENCE,
        balanceBefore,
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
        return this.reject(snapshot, transactions, error.code, balanceBefore);
      }
      if (
        error instanceof InvalidWalletLedgerEntryError ||
        error instanceof DuplicateLedgerReversalError
      ) {
        return this.reject(
          snapshot,
          transactions,
          WagerRejectionCode.INVALID_REFERENCE,
          balanceBefore,
        );
      }
      throw error;
    }
  }

  /** Persiste uma rejeição auditável sem modificar saldo ou ledger. */
  private reject(
    snapshot: WagerTransactionSnapshot,
    transactions: WalletTransactionContext['transactions'],
    code: (typeof WagerRejectionCode)[keyof typeof WagerRejectionCode],
    responseBalance: Money,
  ): WagerTransaction {
    const rejected = WagerTransaction.rehydrate(snapshot);
    rejected.reject(code);
    rejected.recordResponseBalance(responseBalance);
    transactions.insert(rejected);
    return rejected;
  }
}

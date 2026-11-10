import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Money } from '../../domain/money.js';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionType,
} from '../../domain/wager-transaction.js';
import { Wallet } from '../../domain/wallet.js';
import {
  WALLET_CREATION_UNIT_OF_WORK,
  type OutboxEvent,
  type WalletCreationUnitOfWorkPort,
} from '../ports/persistence.repositories.js';
import { createIntegrationEvent } from '../events/integration-event.js';
import { RequestContext } from '../../observability/request-context.js';

export interface CreateWalletInput {
  playerId: string;
  currency: string;
  initialBalance: Money;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(WALLET_CREATION_UNIT_OF_WORK)
    private readonly unitOfWork: WalletCreationUnitOfWorkPort,
  ) {}

  async execute(input: CreateWalletInput): Promise<Wallet> {
    const wallet = Wallet.open(
      randomUUID(),
      input.playerId,
      input.currency,
      input.initialBalance,
    );
    let openingTransaction: WagerTransaction | null = null;
    let openingEntry: WalletLedgerEntry | null = null;
    const outboxEvents: OutboxEvent[] = [];

    if (input.initialBalance.isPositive()) {
      const openingId = randomUUID();
      const internalKey = `internal:opening:${wallet.id}`;
      openingTransaction = WagerTransaction.createInternalOpening({
        id: openingId,
        providerId: 'internal',
        externalTransactionId: internalKey,
        idempotencyKey: internalKey,
        payloadHash: createHash('sha256')
          .update(
            JSON.stringify({
              amount: input.initialBalance.toJSON().amount,
              currency: input.currency,
              kind: WagerTransactionType.OPENING,
              walletId: wallet.id,
            }),
          )
          .digest('hex'),
        walletId: wallet.id,
        playerId: input.playerId,
        roundId: 'internal',
        gameId: 'internal',
        amount: input.initialBalance,
        currency: input.currency,
      });
      openingTransaction.markProcessed();
      openingTransaction.recordResponseBalance(wallet.balance);
      openingEntry = WalletLedgerEntry.createForTransaction({
        id: randomUUID(),
        transaction: openingTransaction,
        balanceBefore: Money.zero(input.currency),
      });
      const eventContext = {
        correlationId:
          RequestContext.currentCorrelationId ?? openingTransaction.id,
        causationId: openingTransaction.id,
      };
      outboxEvents.push(
        createIntegrationEvent('WagerTransactionProcessed', {
          id: randomUUID(),
          aggregateId: openingTransaction.id,
          ...eventContext,
          payload: {
            transactionId: openingTransaction.id,
            providerId: openingTransaction.providerId,
            externalTransactionId: openingTransaction.externalTransactionId,
            kind: openingTransaction.kind,
            amount: openingTransaction.amount.toJSON().amount,
            currency: openingTransaction.currency,
            balance: wallet.balance.toJSON().amount,
          },
          occurredAt: new Date(),
        }),
        createIntegrationEvent('WalletBalanceChanged', {
          id: randomUUID(),
          aggregateId: wallet.id,
          ...eventContext,
          payload: {
            walletId: wallet.id,
            transactionId: openingTransaction.id,
            currency: wallet.currency,
            balanceBefore: Money.zero(input.currency).toJSON().amount,
            balanceAfter: wallet.balance.toJSON().amount,
          },
          occurredAt: new Date(),
        }),
      );
    }

    await this.unitOfWork.create(
      wallet,
      openingTransaction,
      openingEntry,
      outboxEvents,
    );
    return wallet;
  }
}

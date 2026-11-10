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
import {
  createIntegrationEvent,
  WalletBalanceChanged,
} from '../events/integration-event.js';
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
    // Cria a carteira com o saldo inicial informado.
    const wallet = Wallet.open(
      randomUUID(),
      input.playerId,
      input.currency,
      input.initialBalance,
    );

    let openingTransaction: WagerTransaction | null = null;
    let openingEntry: WalletLedgerEntry | null = null;

    // Os eventos serão persistidos junto com a carteira e o ledger.
    const outboxEvents: OutboxEvent[] = [];

    // Só cria uma transação OPENING quando existe saldo inicial positivo.
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

      // Marca a transação de abertura como processada.
      openingTransaction.markProcessed();

      // Registra o saldo resultante da abertura.
      openingTransaction.recordResponseBalance(wallet.balance);

      // Cria o lançamento contábil correspondente ao saldo inicial.
      openingEntry = WalletLedgerEntry.createForTransaction({
        id: randomUUID(),
        transaction: openingTransaction,
        balanceBefore: Money.zero(input.currency),
      });

      // Mantém correlação e causalidade entre os eventos da abertura.
      const eventContext = {
        correlationId:
          RequestContext.currentCorrelationId ?? openingTransaction.id,
        causationId: openingTransaction.id,
      };

      // Evento informando que a transação OPENING foi processada.
      const transactionProcessedEvent = createIntegrationEvent(
        'WagerTransactionProcessed',
        {
          eventId: randomUUID(),
          aggregateId: openingTransaction.id,
          ...eventContext,
          data: {
            transactionId: openingTransaction.id,
            providerId: openingTransaction.providerId,
            externalTransactionId:
              openingTransaction.externalTransactionId,
            kind: openingTransaction.kind,
            amount: openingTransaction.amount.toJSON().amount,
            currency: openingTransaction.currency,
            balance: wallet.balance.toJSON().amount,
          },
          occurredAt: new Date(),
        },
      );

      // Garante que o lançamento existe antes de publicar a alteração de saldo.
      if (!openingEntry) {
        throw new Error(
          'Invariante violada: transação OPENING sem lançamento no ledger.',
        );
      }

      // Evento de alteração de saldo construído pela classe concreta.
      const balanceChangedEvent = WalletBalanceChanged.from(
        wallet,
        openingEntry,
        eventContext,
      );

      // Adiciona os dois eventos à mesma unidade de trabalho.
      outboxEvents.push(
        transactionProcessedEvent,
        balanceChangedEvent,
      );
    }

    // Persiste carteira, transação, lançamento e eventos atomicamente.
    await this.unitOfWork.create(
      wallet,
      openingTransaction,
      openingEntry,
      outboxEvents,
    );

    return wallet;
  }
}

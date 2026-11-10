import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { InboxMessage } from '../ports/persistence.repositories.js';
import { Money } from '../../domain/money.js';
import { WagerTransaction } from '../../domain/wager-transaction.js';
import type { WagerTransactionRequestDto } from './wager-transaction-request.js';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case.js';

@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly processTransaction: ProcessWagerTransactionUseCase,
  ) {}

  execute(
    body: WagerTransactionRequestDto,
    idempotencyKey: string,
  ): Promise<WagerTransaction>;
  execute(
    body: WagerTransactionRequestDto,
    idempotencyKey: string,
    inboxMessage: InboxMessage,
  ): Promise<WagerTransaction | null>;
  execute(
    body: WagerTransactionRequestDto,
    idempotencyKey: string,
    inboxMessage?: InboxMessage,
  ): Promise<WagerTransaction | null> {
    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      idempotencyKey,
      payloadHash: '0'.repeat(64),
      walletId: body.walletId,
      playerId: body.playerId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      amount: Money.from({ amount: body.amount, currency: body.currency }),
      currency: body.currency,
      referenceExternalTransactionId:
        body.referenceExternalTransactionId ?? null,
      referenceTransactionId: body.referenceTransactionId ?? null,
    });

    return inboxMessage
      ? this.processTransaction.executeFromQueue(transaction, inboxMessage)
      : this.processTransaction.execute(transaction);
  }
}

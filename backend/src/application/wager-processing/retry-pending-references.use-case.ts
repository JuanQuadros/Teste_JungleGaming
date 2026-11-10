import { Inject, Injectable } from '@nestjs/common';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepositoryPort,
} from '../ports/persistence.repositories.js';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case.js';

@Injectable()
export class RetryPendingReferencesUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepositoryPort,
    private readonly processTransaction: ProcessWagerTransactionUseCase,
  ) {}

  async execute(now = new Date(), limit = 50): Promise<number> {
    const due = await this.transactions.findDuePendingReferences(now, limit);
    for (const { idempotencyKey } of due) {
      await this.processTransaction.retryPendingReference(idempotencyKey, now);
    }
    return due.length;
  }
}

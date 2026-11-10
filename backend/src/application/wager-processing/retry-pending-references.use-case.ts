import { Inject, Injectable } from '@nestjs/common';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepositoryPort,
} from '../ports/persistence.repositories.js';
import { WagerTransactionStatus } from '../../domain/wager-transaction.js';
import { MetricsService } from '../../observability/metrics.service.js';
import { StructuredLogger } from '../../observability/structured-logger.js';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case.js';
import { isDatabaseLockConflict } from './database-lock-conflict.js';

@Injectable()
export class RetryPendingReferencesUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepositoryPort,
    private readonly processTransaction: ProcessWagerTransactionUseCase,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLogger,
  ) {}

  async execute(now = new Date(), limit = 50): Promise<number> {
    const due = await this.transactions.findDuePendingReferences(now, limit);
    for (const { idempotencyKey } of due) {
      const startedAt = process.hrtime.bigint();
      try {
        const transaction = await this.processTransaction.retryPendingReference(
          idempotencyKey,
          now,
        );
        if (!transaction) continue;

        const status = this.metricStatus(transaction.status);
        const durationSeconds =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
        this.metrics.recordRetry(
          'pending_reference',
          status === 'pending_reference' ? 'scheduled' : 'succeeded',
        );
        this.metrics.recordTransactionStatus('pending_reference', status);
        this.metrics.recordTransactionProcessingDuration(
          'pending_reference',
          status,
          durationSeconds,
        );
        this.logger.info('pending_reference_retry_completed', {
          transactionId: transaction.id,
          walletId: transaction.walletId,
          providerId: transaction.providerId,
          status,
          durationSeconds,
        });
      } catch (error) {
        const durationSeconds =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
        if (isDatabaseLockConflict(error)) {
          this.metrics.recordLockConflict('transaction');
        }
        this.metrics.recordRetry('pending_reference', 'failed');
        this.logger.errorEvent('pending_reference_retry_failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          durationSeconds,
        });
        throw error;
      }
    }
    return due.length;
  }

  private metricStatus(
    status: WagerTransactionStatus,
  ): 'pending_reference' | 'processed' | 'rejected' | 'failed' {
    switch (status) {
      case WagerTransactionStatus.PENDING_REFERENCE:
        return 'pending_reference';
      case WagerTransactionStatus.PROCESSED:
        return 'processed';
      case WagerTransactionStatus.REJECTED:
        return 'rejected';
      case WagerTransactionStatus.FAILED:
        return 'failed';
      case WagerTransactionStatus.PENDING:
        throw new Error(
          'Uma transação não pode terminar o retry como PENDING.',
        );
    }
  }
}

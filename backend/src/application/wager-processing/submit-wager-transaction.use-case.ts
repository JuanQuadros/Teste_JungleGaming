import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { InboxMessage } from '../ports/persistence.repositories.js';
import { Money } from '../../domain/money.js';
import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.js';
import type { WagerTransactionRequestDto } from './wager-transaction-request.js';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case.js';
import { MetricsService } from '../../observability/metrics.service.js';
import { StructuredLogger } from '../../observability/structured-logger.js';

@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly processTransaction: ProcessWagerTransactionUseCase,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLogger,
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

    const source = inboxMessage ? 'sqs' : 'http';
    const startedAt = process.hrtime.bigint();
    const operation = inboxMessage
      ? this.processTransaction.executeFromQueue(transaction, inboxMessage)
      : this.processTransaction.execute(transaction);
    return operation
      .then((result) => {
        const durationSeconds =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
        if (!result) {
          if (!inboxMessage) {
            throw new Error(
              'Uma transação HTTP não pode ser deduplicada pela inbox.',
            );
          }
          this.metrics.recordDuplicateTransaction('sqs');
          this.logger.info('wager_transaction_duplicate', {
            source,
            messageId: inboxMessage.messageId,
            walletId: transaction.walletId,
            providerId: transaction.providerId,
          });
          return null;
        }

        const status = this.metricStatus(result.status);
        this.metrics.recordTransactionStatus(source, status);
        this.metrics.recordTransactionProcessingDuration(
          source,
          status,
          durationSeconds,
        );
        this.logger.info('wager_transaction_processed', {
          source,
          transactionId: result.id,
          walletId: result.walletId,
          providerId: result.providerId,
          status,
          durationSeconds,
          ...(inboxMessage ? { messageId: inboxMessage.messageId } : {}),
        });
        return result;
      })
      .catch((error: unknown) => {
        const durationSeconds =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
        this.metrics.recordTransactionStatus(source, 'failed');
        this.metrics.recordTransactionProcessingDuration(
          source,
          'failed',
          durationSeconds,
        );
        this.logger.errorEvent('wager_transaction_processing_failed', {
          source,
          transactionId: transaction.id,
          walletId: transaction.walletId,
          providerId: transaction.providerId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          durationSeconds,
          ...(inboxMessage ? { messageId: inboxMessage.messageId } : {}),
        });
        throw error;
      });
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
          'Uma transação não pode terminar o processamento como PENDING.',
        );
    }
  }
}

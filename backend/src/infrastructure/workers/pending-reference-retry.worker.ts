import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { RequestContext } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { RetryPendingReferencesUseCase } from '../../application/wager-processing/retry-pending-references.use-case.js';
import { StructuredLogger } from '../../observability/structured-logger.js';

const POLL_INTERVAL_MS = 1_000;

@Injectable()
export class PendingReferenceRetryWorker
  implements OnModuleInit, OnModuleDestroy
{
  private interval: ReturnType<typeof setInterval> | null = null;
  private currentPoll: Promise<void> | null = null;

  constructor(
    private readonly retryPendingReferences: RetryPendingReferencesUseCase,
    private readonly entityManager: EntityManager,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  onModuleInit(): void {
    this.interval = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    if (this.currentPoll) await this.currentPoll;
  }

  private poll(): void {
    if (this.currentPoll) return;
    this.currentPoll = RequestContext.create(
      this.entityManager.fork({ useContext: true }),
      () => this.retryPendingReferences.execute(),
    )
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.errorEvent('pending_reference_retry_batch_failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      })
      .finally(() => {
        this.currentPoll = null;
      });
  }
}

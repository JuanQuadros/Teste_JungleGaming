import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { RequestContext } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  OUTBOX_EVENT_REPOSITORY,
  type OutboxEventRepositoryPort,
  type PendingOutboxEvent,
} from '../../application/ports/persistence.repositories.js';
import { isDatabaseLockConflict } from '../../application/wager-processing/database-lock-conflict.js';
import { MetricsService } from '../../observability/metrics.service.js';
import { StructuredLogger } from '../../observability/structured-logger.js';

const QUEUE_NAME = 'wager-events.fifo';
const POLL_INTERVAL_MS = 1_000;
const BATCH_SIZE = 10;
const LEASE_DURATION_MS = 5 * 60 * 1_000;
const MAX_RETRY_DELAY_SECONDS = 300;

@Injectable()
export class OutboxSqsPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private interval: ReturnType<typeof setInterval> | null = null;
  private currentPoll: Promise<void> | null = null;
  private queueUrl: string | null = null;
  private stopping = false;

  constructor(
    private readonly sqsClient: SQSClient,
    private readonly entityManager: EntityManager,
    @Inject(OUTBOX_EVENT_REPOSITORY)
    private readonly outbox: OutboxEventRepositoryPort,
    private readonly metrics: MetricsService,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  onModuleInit(): void {
    this.interval = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    if (this.currentPoll) await this.currentPoll;
  }

  private poll(): void {
    if (this.stopping || this.currentPoll) return;
    this.currentPoll = RequestContext.create(
      this.entityManager.fork({ useContext: true }),
      () => this.publishBatch(),
    )
      .catch((error: unknown) => {
        if (isDatabaseLockConflict(error)) {
          this.metrics.recordLockConflict('outbox');
        }
        this.logger.errorEvent('outbox_publish_batch_failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      })
      .finally(() => {
        this.currentPoll = null;
      });
  }

  private async publishBatch(): Promise<void> {
    const queueUrl = await this.resolveQueueUrl();
    const now = new Date();
    const events = await this.outbox.claimDue(
      now,
      new Date(now.getTime() + LEASE_DURATION_MS),
      BATCH_SIZE,
    );
    if (events.length === 0) return;
    for (const event of events) {
      await this.publishOne(queueUrl, event);
    }
  }

  private async resolveQueueUrl(): Promise<string> {
    if (this.queueUrl) return this.queueUrl;
    const configuredQueueUrl = process.env.WAGER_EVENTS_QUEUE_URL;
    if (configuredQueueUrl) {
      this.queueUrl = configuredQueueUrl;
      return configuredQueueUrl;
    }
    const result = await this.sqsClient.send(
      new GetQueueUrlCommand({ QueueName: QUEUE_NAME }),
    );
    if (!result.QueueUrl) {
      throw new Error(`SQS queue ${QUEUE_NAME} did not return a URL.`);
    }
    this.queueUrl = result.QueueUrl;
    return result.QueueUrl;
  }

  private async publishOne(
    queueUrl: string,
    event: PendingOutboxEvent,
  ): Promise<void> {
    const startedAt = process.hrtime.bigint();
    try {
      await this.sqsClient.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageGroupId: event.aggregateId,
          MessageDeduplicationId: event.id,
          MessageBody: JSON.stringify({
            eventId: event.id,
            aggregateId: event.aggregateId,
            correlationId: event.correlationId,
            ...(event.causationId ? { causationId: event.causationId } : {}),
            occurredAt: event.occurredAt.toISOString(),
            version: event.version,
            eventType: event.eventType,
            data: event.payload,
          }),
        }),
      );
      const publishedAt = new Date();
      this.metrics.recordOutboxPublishDelay(
        Math.max(0, publishedAt.getTime() - event.occurredAt.getTime()) / 1_000,
      );
      if (event.attempts > 1) {
        this.metrics.recordRetry('outbox', 'succeeded');
      }
      const marked = await this.outbox.markPublished(
        event.id,
        event.attempts,
        publishedAt,
      );
      this.logger.info('outbox_event_published', {
        eventId: event.id,
        aggregateId: event.aggregateId,
        attempt: event.attempts,
        durationSeconds:
          Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
      });
      if (!marked) {
        this.logger.errorEvent('outbox_publish_mark_lost', {
          eventId: event.id,
          aggregateId: event.aggregateId,
          attempt: event.attempts,
        });
      }
    } catch (error) {
      const retryDelaySeconds = Math.min(
        2 ** Math.min(event.attempts - 1, 8),
        MAX_RETRY_DELAY_SECONDS,
      );
      const retryAt = new Date(Date.now() + retryDelaySeconds * 1_000);
      let scheduled = false;
      try {
        scheduled = await this.outbox.scheduleRetry(
          event.id,
          event.attempts,
          retryAt,
        );
      } catch (retryError) {
        if (isDatabaseLockConflict(retryError)) {
          this.metrics.recordLockConflict('outbox');
        }
        this.logger.errorEvent('outbox_retry_schedule_failed', {
          errorName:
            retryError instanceof Error ? retryError.name : 'UnknownError',
          eventId: event.id,
          aggregateId: event.aggregateId,
          attempt: event.attempts,
        });
      }
      if (isDatabaseLockConflict(error)) {
        this.metrics.recordLockConflict('outbox');
      }
      this.metrics.recordRetry('outbox', scheduled ? 'scheduled' : 'failed');
      this.logger.errorEvent('outbox_publish_failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        eventId: event.id,
        aggregateId: event.aggregateId,
        attempt: event.attempts,
        retryScheduled: scheduled ? 1 : 0,
        durationSeconds:
          Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
      });
    }
  }
}

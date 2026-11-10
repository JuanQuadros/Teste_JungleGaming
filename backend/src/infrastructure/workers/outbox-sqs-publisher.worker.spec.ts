import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { describe, expect, it, vi } from 'vitest';
import type {
  OutboxEventRepositoryPort,
  PendingOutboxEvent,
} from '../../application/ports/persistence.repositories.js';
import { MetricsService } from '../../observability/metrics.service.js';
import { StructuredLogger } from '../../observability/structured-logger.js';
import { OutboxSqsPublisherWorker } from './outbox-sqs-publisher.worker.js';

const pendingEvent: PendingOutboxEvent = {
  id: '00000000-0000-4000-8000-000000000101',
  aggregateId: '00000000-0000-4000-8000-000000000201',
  eventType: 'WagerTransactionReferenceExpired',
  correlationId: '00000000-0000-4000-8000-000000000301',
  causationId: '00000000-0000-4000-8000-000000000401',
  version: 1,
  payload: { transactionId: 'transaction-1', attempts: 5 },
  occurredAt: new Date('2026-11-10T00:00:00.000Z'),
  attempts: 1,
};

describe('OutboxSqsPublisherWorker', () => {
  it('publishes the stable event envelope and marks it only after SQS accepts it', async () => {
    const sent = deferred<SendMessageCommand>();
    const published = deferred<void>();
    const markPublished = vi.fn(async () => {
      published.resolve();
      return true;
    });
    const send = vi.fn(async (command: unknown): Promise<unknown> => {
      if (command instanceof GetQueueUrlCommand) {
        return { QueueUrl: 'http://local/sqs/wager-events.fifo' };
      }
      if (command instanceof SendMessageCommand) {
        sent.resolve(command);
        return { MessageId: 'sqs-event-1' };
      }
      throw new Error('Unexpected SQS command in test.');
    });
    const repository = createRepository({ markPublished });
    const metrics = new MetricsService();
    const worker = createWorker(send, repository, metrics);

    worker.onModuleInit();
    const command = await sent.promise;
    expect(command.input).toMatchObject({
      MessageGroupId: pendingEvent.aggregateId,
      MessageDeduplicationId: pendingEvent.id,
      MessageBody: JSON.stringify({
        eventId: pendingEvent.id,
        aggregateId: pendingEvent.aggregateId,
        correlationId: pendingEvent.correlationId,
        causationId: pendingEvent.causationId,
        occurredAt: pendingEvent.occurredAt.toISOString(),
        version: pendingEvent.version,
        eventType: pendingEvent.eventType,
        data: pendingEvent.payload,
      }),
    });
    expect(markPublished).not.toHaveBeenCalled();

    await published.promise;
    expect(markPublished).toHaveBeenCalledWith(
      pendingEvent.id,
      pendingEvent.attempts,
      expect.any(Date),
    );
    expect(metrics.renderPrometheus()).toContain(
      'outbox_publish_delay_seconds_count 1',
    );
    await worker.onModuleDestroy();
  });

  it('schedules a persistent exponential retry when SQS rejects an event', async () => {
    const retried = deferred<void>();
    const markPublished = vi.fn(async () => true);
    const scheduledTimes: Date[] = [];
    const scheduleRetry = vi.fn(
      async (_id: string, _attempts: number, retryAt: Date) => {
        scheduledTimes.push(retryAt);
        retried.resolve();
        return true;
      },
    );
    const send = vi.fn(async (command: unknown): Promise<unknown> => {
      if (command instanceof GetQueueUrlCommand) {
        return { QueueUrl: 'http://local/sqs/wager-events.fifo' };
      }
      if (command instanceof SendMessageCommand) {
        throw new Error('SQS unavailable');
      }
      throw new Error('Unexpected SQS command in test.');
    });
    const repository = createRepository({ markPublished, scheduleRetry });
    const metrics = new MetricsService();
    const worker = createWorker(send, repository, metrics);

    worker.onModuleInit();
    await retried.promise;
    await new Promise((resolve) => setImmediate(resolve));
    const retryAt = scheduledTimes[0];
    expect(retryAt.getTime()).toBeGreaterThan(Date.now());
    expect(markPublished).not.toHaveBeenCalled();
    expect(metrics.renderPrometheus()).toContain(
      'wager_retries_total{source="outbox",result="scheduled"} 1',
    );
    await worker.onModuleDestroy();
  });
});

function createWorker(
  send: ReturnType<typeof vi.fn>,
  repository: OutboxEventRepositoryPort,
  metrics = new MetricsService(),
): OutboxSqsPublisherWorker {
  const fakeClient = { send, destroy: vi.fn() } as unknown as SQSClient;
  const entityManager = {
    name: 'default',
    fork: () => entityManager,
  } as unknown as EntityManager;
  const logger = {
    errorEvent: vi.fn(),
  } as unknown as StructuredLogger;
  return new OutboxSqsPublisherWorker(
    fakeClient,
    entityManager,
    repository,
    metrics,
    logger,
  );
}

function createRepository(
  overrides: Partial<OutboxEventRepositoryPort> = {},
): OutboxEventRepositoryPort {
  return {
    insert: vi.fn(),
    claimDue: vi.fn(async () => [pendingEvent]),
    markPublished: vi.fn(async () => true),
    scheduleRetry: vi.fn(async () => true),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

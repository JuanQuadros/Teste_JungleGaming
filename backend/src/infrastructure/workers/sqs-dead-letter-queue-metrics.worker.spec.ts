import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { describe, expect, it, vi } from 'vitest';
import { MetricsService } from '../../observability/metrics.service.js';
import { StructuredLogger } from '../../observability/structured-logger.js';
import { SqsDeadLetterQueueMetricsWorker } from './sqs-dead-letter-queue-metrics.worker.js';

describe('SqsDeadLetterQueueMetricsWorker', () => {
  it('records the approximate depth of both dead-letter queues', async () => {
    const refreshed = deferred<void>();
    const send = vi.fn(async (command: unknown): Promise<unknown> => {
      if (command instanceof GetQueueUrlCommand) {
        return { QueueUrl: `http://local/sqs/${command.input.QueueName}` };
      }
      if (command instanceof GetQueueAttributesCommand) {
        if (command.input.QueueUrl?.includes('transactions')) {
          return {
            Attributes: {
              ApproximateNumberOfMessages: '2',
              ApproximateNumberOfMessagesNotVisible: '1',
              ApproximateNumberOfMessagesDelayed: '0',
            },
          };
        }
        refreshed.resolve();
        return {
          Attributes: {
            ApproximateNumberOfMessages: '4',
            ApproximateNumberOfMessagesNotVisible: '0',
            ApproximateNumberOfMessagesDelayed: '1',
          },
        };
      }
      throw new Error('Unexpected SQS command in test.');
    });
    const metrics = new MetricsService();
    const worker = new SqsDeadLetterQueueMetricsWorker(
      { send, destroy: vi.fn() } as unknown as SQSClient,
      metrics,
      { errorEvent: vi.fn() } as unknown as StructuredLogger,
    );

    worker.onModuleInit();
    await refreshed.promise;
    await new Promise((resolve) => setImmediate(resolve));

    expect(metrics.renderPrometheus()).toContain(
      'sqs_dead_letter_queue_messages{queue="transactions"} 3',
    );
    expect(metrics.renderPrometheus()).toContain(
      'sqs_dead_letter_queue_messages{queue="events"} 5',
    );
    await worker.onModuleDestroy();
  });

  it('logs missing depth data without exporting a false zero', async () => {
    const refreshed = deferred<void>();
    const send = vi.fn(async (command: unknown): Promise<unknown> => {
      if (command instanceof GetQueueUrlCommand) {
        return { QueueUrl: `http://local/sqs/${command.input.QueueName}` };
      }
      if (command instanceof GetQueueAttributesCommand) {
        refreshed.resolve();
        return { Attributes: {} };
      }
      throw new Error('Unexpected SQS command in test.');
    });
    const metrics = new MetricsService();
    const errorEvent = vi.fn();
    const logger = { errorEvent } as unknown as StructuredLogger;
    const worker = new SqsDeadLetterQueueMetricsWorker(
      { send, destroy: vi.fn() } as unknown as SQSClient,
      metrics,
      logger,
    );

    worker.onModuleInit();
    await refreshed.promise;
    await new Promise((resolve) => setImmediate(resolve));

    expect(metrics.renderPrometheus()).not.toContain(
      'sqs_dead_letter_queue_messages{',
    );
    expect(errorEvent).toHaveBeenCalledWith(
      'sqs_dead_letter_queue_metrics_failed',
      expect.objectContaining({ errorName: 'Error' }),
    );
    await worker.onModuleDestroy();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

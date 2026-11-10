import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { describe, expect, it, vi } from 'vitest';
import { SubmitWagerTransactionUseCase } from '../../application/wager-processing/submit-wager-transaction.use-case.js';
import { StructuredLogger } from '../../observability/structured-logger.js';
import { WagerTransactionSqsConsumer } from './wager-transaction-sqs.consumer.js';

const messageBody = JSON.stringify({
  idempotencyKey: 'queue-idempotency-1',
  transaction: {
    providerId: 'provider-1',
    externalTransactionId: 'external-1',
    walletId: '00000000-0000-4000-8000-000000000001',
    playerId: '00000000-0000-4000-8000-000000000002',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
  },
});

describe('WagerTransactionSqsConsumer', () => {
  it('deletes only after the financial use case commits and drains on shutdown', async () => {
    const processStarted = deferred<void>();
    const allowCommit = deferred<void>();
    const messageDeleted = deferred<void>();
    const events: string[] = [];
    const { consumer, send } = createConsumer(async () => {
      events.push('process-started');
      processStarted.resolve();
      await allowCommit.promise;
      events.push('process-committed');
      return { committed: true };
    }, messageDeleted);

    consumer.onModuleInit();
    await processStarted.promise;
    expect(events).toEqual(['process-started']);

    allowCommit.resolve();
    await messageDeleted.promise;
    expect(events).toEqual(['process-started', 'process-committed']);
    await consumer.onModuleDestroy();
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof DeleteMessageCommand,
      ),
    ).toBe(true);
  });

  it('leaves a failed message undeleted and schedules its retry', async () => {
    const retryScheduled = deferred<void>();
    const { consumer, send } = createConsumer(async () => {
      throw new Error('database unavailable');
    }, retryScheduled);

    consumer.onModuleInit();
    await retryScheduled.promise;
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof DeleteMessageCommand,
      ),
    ).toBe(false);
    const retryCommand = send.mock.calls.find(
      ([command]) => command instanceof ChangeMessageVisibilityCommand,
    )?.[0] as ChangeMessageVisibilityCommand | undefined;
    expect(retryCommand?.input.VisibilityTimeout).toBe(1);
    await consumer.onModuleDestroy();
  });
});

function createConsumer(
  execute: () => Promise<unknown>,
  completed: ReturnType<typeof deferred<void>>,
) {
  let receiveCount = 0;
  const send = vi.fn(
    async (
      command: unknown,
      options?: { abortSignal?: AbortSignal },
    ): Promise<unknown> => {
      if (command instanceof GetQueueUrlCommand) {
        return { QueueUrl: 'http://local/sqs/wager-transactions.fifo' };
      }
      if (command instanceof ReceiveMessageCommand) {
        receiveCount += 1;
        if (receiveCount === 1) {
          return {
            Messages: [
              {
                MessageId: 'message-1',
                ReceiptHandle: 'receipt-1',
                Body: messageBody,
                Attributes: { ApproximateReceiveCount: '1' },
              },
            ],
          };
        }
        return new Promise((_, reject) => {
          options?.abortSignal?.addEventListener(
            'abort',
            () => reject(new Error('long poll aborted')),
            { once: true },
          );
        });
      }
      if (command instanceof DeleteMessageCommand) {
        completed.resolve();
        return {};
      }
      if (command instanceof ChangeMessageVisibilityCommand) {
        completed.resolve();
        return {};
      }
      throw new Error('Unexpected SQS command in test.');
    },
  );
  const fakeClient = { send, destroy: vi.fn() } as unknown as SQSClient;
  const entityManager = {
    name: 'default',
    fork: () => entityManager,
  } as unknown as EntityManager;
  const submitTransaction = {
    execute,
  } as unknown as SubmitWagerTransactionUseCase;
  const logger = {
    errorEvent: vi.fn(),
  } as unknown as StructuredLogger;
  const consumer = new WagerTransactionSqsConsumer(
    fakeClient,
    entityManager,
    submitTransaction,
    logger,
  );
  if (completed === undefined)
    throw new Error('Completion signal is required.');
  return { consumer, send };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

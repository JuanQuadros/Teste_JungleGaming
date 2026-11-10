import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '../../domain/money.js';
import {
  createPostgresTestSchema,
  type PostgresTestSchema,
} from '../../../test/postgres-test-schema.js';
import { ProcessWagerTransactionUseCase } from '../../application/wager-processing/process-wager-transaction.use-case.js';
import { SubmitWagerTransactionUseCase } from '../../application/wager-processing/submit-wager-transaction.use-case.js';
import { CreateWalletUseCase } from '../../application/wallet-management/create-wallet.use-case.js';
import { MikroOrmWalletTransactionUnitOfWork } from '../persistence/mikro-orm-wallet-transaction.unit-of-work.js';
import { MikroOrmOutboxEventRepository } from '../persistence/repositories/mikro-orm-outbox-event.repository.js';
import { MetricsService } from '../../observability/metrics.service.js';
import { RequestContext } from '../../observability/request-context.js';
import { StructuredLogger } from '../../observability/structured-logger.js';
import { OutboxSqsPublisherWorker } from './outbox-sqs-publisher.worker.js';
import { WagerTransactionSqsConsumer } from './wager-transaction-sqs.consumer.js';

describe('PostgreSQL and LocalStack integration', () => {
  let schema: PostgresTestSchema;
  let sqs: SQSClient;
  let transactionQueueUrl: string;
  let eventsQueueUrl: string;
  let transactionQueueName: string;
  let eventsQueueName: string;
  let oldTransactionsQueueUrl: string | undefined;
  let oldEventsQueueUrl: string | undefined;
  const queueNames: string[] = [];

  beforeAll(async () => {
    schema = await createPostgresTestSchema('sqs_integration');
    await schema.migrateUp();
    const endpoint = process.env.AWS_ENDPOINT_URL;
    if (!endpoint) {
      throw new Error(
        'AWS_ENDPOINT_URL is required for real LocalStack integration tests.',
      );
    }
    const parsedEndpoint = new URL(endpoint);
    if (
      parsedEndpoint.protocol !== 'http:' ||
      !['localhost', '127.0.0.1'].includes(parsedEndpoint.hostname)
    ) {
      throw new Error(
        'Integration tests require a local HTTP LocalStack endpoint.',
      );
    }
    sqs = new SQSClient({
      endpoint,
      region: process.env.AWS_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });

    oldTransactionsQueueUrl = process.env.WAGER_TRANSACTIONS_QUEUE_URL;
    oldEventsQueueUrl = process.env.WAGER_EVENTS_QUEUE_URL;
    const suffix = randomUUID().replaceAll('-', '');
    transactionQueueName = `integration-${suffix}-transactions.fifo`;
    eventsQueueName = `integration-${suffix}-events.fifo`;
    transactionQueueUrl = await createQueue(transactionQueueName, {
      VisibilityTimeout: '1',
    });
    eventsQueueUrl = await createQueue(eventsQueueName);
  }, 60_000);

  afterAll(async () => {
    restoreQueueUrl('WAGER_TRANSACTIONS_QUEUE_URL', oldTransactionsQueueUrl);
    restoreQueueUrl('WAGER_EVENTS_QUEUE_URL', oldEventsQueueUrl);
    if (sqs) {
      for (const queueName of queueNames.reverse()) {
        const result = await sqs.send(
          new GetQueueUrlCommand({ QueueName: queueName }),
        );
        if (result.QueueUrl) {
          await sqs.send(new DeleteQueueCommand({ QueueUrl: result.QueueUrl }));
        }
      }
      sqs.destroy();
    }
    await schema?.close();
  });

  it('publishes a committed outbox event to a real FIFO queue', async () => {
    const event = {
      id: randomUUID(),
      aggregateId: randomUUID(),
      eventType: 'IntegrationEvent',
      payload: { value: 'persisted' },
      occurredAt: new Date(),
    };
    await schema.orm.em.transactional(async (em) => {
      new MikroOrmOutboxEventRepository(em).insert(event);
    });
    withQueueUrl('WAGER_EVENTS_QUEUE_URL', eventsQueueUrl);

    const worker = new OutboxSqsPublisherWorker(
      sqs,
      schema.orm.em as EntityManager,
      new MikroOrmOutboxEventRepository(schema.orm.em.fork()),
      new MetricsService(),
      new StructuredLogger(new RequestContext()),
    );
    worker.onModuleInit();
    try {
      const message = await receiveUntilMessage(eventsQueueUrl);
      expect(JSON.parse(message.Body ?? 'null')).toEqual({
        eventId: event.id,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        occurredAt: event.occurredAt.toISOString(),
        payload: event.payload,
      });
      await waitFor(async () => {
        const rows = (await schema.orm.em
          .getConnection()
          .execute(
            `select published_at from "${schema.name}".outbox_messages where id = ?`,
            [event.id],
          )) as { published_at: Date | null }[];
        return rows[0]?.published_at !== null;
      });
    } finally {
      await worker.onModuleDestroy();
    }
  }, 30_000);

  it('consumes actual SQS deliveries and commits inbox, wallet, ledger, and outbox atomically', async () => {
    const playerId = randomUUID();
    const wallet = await new CreateWalletUseCase(
      new MikroOrmWalletTransactionUnitOfWork(schema.orm.em.fork()),
    ).execute({
      playerId,
      currency: 'BRL',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const request = {
      idempotencyKey: `integration-${randomUUID()}`,
      transaction: {
        providerId: 'localstack-integration',
        externalTransactionId: `external-${randomUUID()}`,
        walletId: wallet.id,
        playerId,
        roundId: 'integration-round',
        gameId: 'integration-game',
        kind: 'BET',
        amount: '10.00',
        currency: 'BRL',
      },
    };
    const messageBody = JSON.stringify(request);
    for (const deduplicationId of [randomUUID(), randomUUID()]) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: transactionQueueUrl,
          MessageGroupId: wallet.id,
          MessageDeduplicationId: deduplicationId,
          MessageBody: messageBody,
        }),
      );
    }
    withQueueUrl('WAGER_TRANSACTIONS_QUEUE_URL', transactionQueueUrl);

    const useCase = new SubmitWagerTransactionUseCase(
      new ProcessWagerTransactionUseCase(
        new MikroOrmWalletTransactionUnitOfWork(schema.orm.em.fork()),
      ),
      new MetricsService(),
      new StructuredLogger(new RequestContext()),
    );
    const consumer = new WagerTransactionSqsConsumer(
      sqs,
      schema.orm.em as EntityManager,
      useCase,
      new MetricsService(),
      new StructuredLogger(new RequestContext()),
    );
    consumer.onModuleInit();
    try {
      await waitFor(async () => {
        const result = (await schema.orm.em.getConnection().execute(
          `select
            (select balance::text from "${schema.name}".wallets where id = ?) as balance,
            (select count(*)::int from "${schema.name}".inbox_messages
             where consumer_name = 'wager-transactions') as inbox_count,
            (select count(*)::int from "${schema.name}".wager_transactions
             where idempotency_key = ?) as transaction_count,
            (select count(*)::int from "${schema.name}".wallet_ledger_entries
             where wallet_id = ?) as ledger_count`,
          [wallet.id, request.idempotencyKey, wallet.id],
        )) as {
          balance: string;
          inbox_count: number;
          transaction_count: number;
          ledger_count: number;
        }[];
        return (
          result[0]?.balance === '90.00' &&
          result[0].inbox_count === 2 &&
          result[0].transaction_count === 1 &&
          result[0].ledger_count === 2
        );
      });
      await waitFor(async () => {
        const attributes = await sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: transactionQueueUrl,
            AttributeNames: [
              'ApproximateNumberOfMessages',
              'ApproximateNumberOfMessagesNotVisible',
            ],
          }),
        );
        return (
          attributes.Attributes?.ApproximateNumberOfMessages === '0' &&
          attributes.Attributes?.ApproximateNumberOfMessagesNotVisible === '0'
        );
      });
    } finally {
      await consumer.onModuleDestroy();
    }

    const outboxRows = (await schema.orm.em.getConnection().execute(
      `select count(*)::int as count from "${schema.name}".outbox_messages
       where event_type in ('WagerTransactionProcessed', 'WalletBalanceChanged')`,
    )) as { count: number }[];
    expect(outboxRows[0].count).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('redrives repeatedly received SQS messages to the real dead-letter queue', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const deadLetterQueueUrl = await createQueue(
      `integration-${suffix}-dlq.fifo`,
    );
    const deadLetterAttributes = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: deadLetterQueueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    const deadLetterArn = deadLetterAttributes.Attributes?.QueueArn;
    if (!deadLetterArn) {
      throw new Error('LocalStack did not return the DLQ ARN.');
    }
    const redriveQueueUrl = await createQueue(
      `integration-${suffix}-redrive.fifo`,
      {
        VisibilityTimeout: '1',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: deadLetterArn,
          maxReceiveCount: '2',
        }),
      },
    );
    const metrics = new MetricsService();
    const logger = new StructuredLogger(new RequestContext());
    withQueueUrl('WAGER_TRANSACTIONS_QUEUE_URL', redriveQueueUrl);
    const consumer = new WagerTransactionSqsConsumer(
      sqs,
      schema.orm.em as EntityManager,
      new SubmitWagerTransactionUseCase(
        new ProcessWagerTransactionUseCase(
          new MikroOrmWalletTransactionUnitOfWork(schema.orm.em.fork()),
        ),
        metrics,
        logger,
      ),
      metrics,
      logger,
    );
    consumer.onModuleInit();
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: redriveQueueUrl,
          MessageGroupId: 'poison-message-group',
          MessageDeduplicationId: randomUUID(),
          MessageBody: JSON.stringify({ invalid: true }),
        }),
      );
      const deadLetterMessage = await receiveUntilMessage(deadLetterQueueUrl);
      expect(deadLetterMessage.Body).toBe(JSON.stringify({ invalid: true }));
      expect(metrics.renderPrometheus()).toContain(
        'wager_retries_total{source="sqs",result="scheduled"} 2',
      );
    } finally {
      await consumer.onModuleDestroy();
    }
  }, 30_000);

  async function createQueue(
    queueName: string,
    additionalAttributes: Record<string, string> = {},
  ): Promise<string> {
    const result = await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          ...additionalAttributes,
        },
      }),
    );
    if (!result.QueueUrl) {
      throw new Error(`LocalStack did not create queue ${queueName}.`);
    }
    queueNames.push(queueName);
    return result.QueueUrl;
  }

  async function receiveUntilMessage(queueUrl: string) {
    return waitFor(async () => {
      return receiveOnce(queueUrl, 1);
    });
  }

  async function receiveOnce(queueUrl: string, waitTimeSeconds: 0 | 1) {
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    return result.Messages?.[0] ?? null;
  }

  async function waitFor<T>(
    operation: () => Promise<T | null | false>,
  ): Promise<T> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const result = await operation();
      if (result) return result as T;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for PostgreSQL or LocalStack state.');
  }

  function withQueueUrl(name: string, value: string): void {
    process.env[name] = value;
  }

  function restoreQueueUrl(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

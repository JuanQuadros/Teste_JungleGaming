import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InboxMessage } from '../../application/ports/persistence.repositories.js';
import { ReconcileWalletUseCase } from '../../application/wallet-management/reconcile-wallet.use-case.js';
import { CreateWalletUseCase } from '../../application/wallet-management/create-wallet.use-case.js';
import { MikroOrmWalletLedgerEntryRepository } from '../persistence/repositories/mikro-orm-wallet-ledger-entry.repository.js';
import { MikroOrmOutboxEventRepository } from '../persistence/repositories/mikro-orm-outbox-event.repository.js';
import { MikroOrmWalletTransactionUnitOfWork } from '../persistence/mikro-orm-wallet-transaction.unit-of-work.js';
import { ProcessWagerTransactionUseCase } from '../../application/wager-processing/process-wager-transaction.use-case.js';
import { SubmitWagerTransactionUseCase } from '../../application/wager-processing/submit-wager-transaction.use-case.js';
import type { WagerTransactionRequestDto } from '../../application/wager-processing/wager-transaction-request.js';
import { Money } from '../../domain/money.js';
import { WagerTransactionType } from '../../domain/wager-transaction.js';
import { mikroOrmConfig } from '../../mikro-orm.config.js';
import { MetricsService } from '../../observability/metrics.service.js';
import { RequestContext } from '../../observability/request-context.js';
import { StructuredLogger } from '../../observability/structured-logger.js';
import {
  createPostgresTestSchema,
  type PostgresTestSchema,
} from '../../../test/postgres-test-schema.js';
import { OutboxSqsPublisherWorker } from './outbox-sqs-publisher.worker.js';
import { WagerTransactionSqsConsumer } from './wager-transaction-sqs.consumer.js';

describe('Concurrency and recovery (PostgreSQL and LocalStack)', () => {
  let schema: PostgresTestSchema;
  let sqs: SQSClient;
  let transactionQueueUrl: string;
  let eventsQueueUrl: string;
  let oldTransactionsQueueUrl: string | undefined;
  let oldEventsQueueUrl: string | undefined;
  const queueNames: string[] = [];

  beforeAll(async () => {
    schema = await createPostgresTestSchema('concurrency_recovery');
    await schema.migrateUp();
    const endpoint = process.env.AWS_ENDPOINT_URL;
    if (!endpoint) {
      throw new Error(
        'AWS_ENDPOINT_URL is required for real LocalStack concurrency tests.',
      );
    }
    const parsedEndpoint = new URL(endpoint);
    if (
      parsedEndpoint.protocol !== 'http:' ||
      !['localhost', '127.0.0.1'].includes(parsedEndpoint.hostname)
    ) {
      throw new Error(
        'Concurrency tests require a local HTTP LocalStack endpoint.',
      );
    }
    sqs = createSqsClient(endpoint);
    oldTransactionsQueueUrl = process.env.WAGER_TRANSACTIONS_QUEUE_URL;
    oldEventsQueueUrl = process.env.WAGER_EVENTS_QUEUE_URL;
    const suffix = randomUUID().replaceAll('-', '');
    eventsQueueUrl = await createQueue(`concurrency-${suffix}-events.fifo`);
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

  it('accepts 50 concurrent copies of one wager as a single debit', async () => {
    const wallet = await createWallet('100.00');
    const idempotencyKey = `replay-${randomUUID()}`;
    const externalTransactionId = `external-${randomUUID()}`;
    const request = wagerRequest(wallet, {
      externalTransactionId,
      amount: '10.00',
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        createSubmitUseCase().execute(request, idempotencyKey),
      ),
    );
    expect(new Set(results.map(({ id }) => id)).size).toBe(1);
    expect(results.every(({ status }) => status === 'PROCESSED')).toBe(true);

    const rows = (await schema.orm.em.getConnection().execute(
      `select
        (select balance::text from "${schema.name}".wallets where id = ?) as balance,
        (select count(*)::int from "${schema.name}".wager_transactions
         where idempotency_key = ?) as transaction_count,
        (select count(*)::int from "${schema.name}".wallet_ledger_entries
         where wallet_id = ? and direction = 'DEBIT') as debit_count`,
      [wallet.id, idempotencyKey, wallet.id],
    )) as { balance: string; transaction_count: number; debit_count: number }[];
    expect(rows[0]).toEqual({
      balance: '90.00',
      transaction_count: 1,
      debit_count: 1,
    });
  }, 30_000);

  it('serializes two 80.00 wagers against a 100.00 balance in PostgreSQL', async () => {
    const wallet = await createWallet('100.00');
    const wagers = [
      {
        key: `race-a-${randomUUID()}`,
        request: wagerRequest(wallet, {
          externalTransactionId: `external-a-${randomUUID()}`,
          amount: '80.00',
        }),
      },
      {
        key: `race-b-${randomUUID()}`,
        request: wagerRequest(wallet, {
          externalTransactionId: `external-b-${randomUUID()}`,
          amount: '80.00',
        }),
      },
    ];

    const results = await Promise.all(
      wagers.map(({ key, request }) =>
        createSubmitUseCase().execute(request, key),
      ),
    );
    expect(results.filter(({ status }) => status === 'PROCESSED')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'REJECTED')).toHaveLength(
      1,
    );

    const rows = (await schema.orm.em.getConnection().execute(
      `select
        (select balance::text from "${schema.name}".wallets where id = ?) as balance,
        (select count(*)::int from "${schema.name}".wallet_ledger_entries
         where wallet_id = ? and direction = 'DEBIT') as debit_count,
        (select count(*)::int from "${schema.name}".wager_transactions
         where id in (?, ?) and status = 'REJECTED') as rejected_count`,
      [wallet.id, wallet.id, ...results.map(({ id }) => id)],
    )) as { balance: string; debit_count: number; rejected_count: number }[];
    expect(rows[0]).toEqual({
      balance: '20.00',
      debit_count: 1,
      rejected_count: 1,
    });
  }, 30_000);

  it('processes separate wallets concurrently through three consumer instances', async () => {
    const wallets = await Promise.all([
      createWallet('20.00'),
      createWallet('20.00'),
      createWallet('20.00'),
    ]);
    const requests = wallets.map((wallet) => ({
      idempotencyKey: `instance-${randomUUID()}`,
      body: wagerRequest(wallet, {
        externalTransactionId: `external-${randomUUID()}`,
        amount: '5.00',
      }),
    }));
    transactionQueueUrl = await createQueue(
      `concurrency-${randomUUID().replaceAll('-', '')}-instances.fifo`,
      { VisibilityTimeout: '1' },
    );
    withQueueUrl('WAGER_TRANSACTIONS_QUEUE_URL', transactionQueueUrl);

    const clients = Array.from({ length: 3 }, () =>
      createSqsClient(process.env.AWS_ENDPOINT_URL!),
    );
    const consumers = clients.map((client) => createConsumer(client));
    for (const consumer of consumers) consumer.onModuleInit();

    try {
      for (const [index, request] of requests.entries()) {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: transactionQueueUrl,
            MessageGroupId: wallets[index].id,
            MessageDeduplicationId: randomUUID(),
            MessageBody: JSON.stringify({
              idempotencyKey: request.idempotencyKey,
              transaction: request.body,
            }),
          }),
        );
      }
      await waitFor(async () => {
        const result = (await schema.orm.em.getConnection().execute(
          `select count(*)::int as count from "${schema.name}".wager_transactions
           where provider_id = 'concurrency-test'
             and idempotency_key in (?, ?, ?)`,
          requests.map(({ idempotencyKey }) => idempotencyKey),
        )) as { count: number }[];
        return result[0]?.count === 3;
      });
      await waitFor(async () => {
        const result = (await schema.orm.em.getConnection().execute(
          `select count(*)::int as count from "${schema.name}".wallets
           where id in (?, ?, ?) and balance = 15.00`,
          wallets.map(({ id }) => id),
        )) as { count: number }[];
        return result[0]?.count === 3;
      });
    } finally {
      await Promise.all(
        consumers.map((consumer) => consumer.onModuleDestroy()),
      );
      for (const client of clients) client.destroy();
    }

    const rows = (await schema.orm.em.getConnection().execute(
      `select count(*)::int as count from "${schema.name}".wallet_ledger_entries
       where wallet_id in (?, ?, ?) and direction = 'DEBIT'`,
      wallets.map(({ id }) => id),
    )) as { count: number }[];
    expect(rows[0].count).toBe(3);
  }, 30_000);

  it('recovers a committed message after a crash before ACK without a second debit', async () => {
    const wallet = await createWallet('50.00');
    const idempotencyKey = `crash-${randomUUID()}`;
    const request = wagerRequest(wallet, {
      externalTransactionId: `external-${randomUUID()}`,
      amount: '10.00',
    });
    const body = JSON.stringify({ idempotencyKey, transaction: request });
    const metrics = new MetricsService();
    const logger = new StructuredLogger(new RequestContext());
    const submit = createSubmitUseCase(metrics, logger);
    let injectedCrash = false;
    let deliveries = 0;
    const commitThenCrash = {
      async execute(
        input: WagerTransactionRequestDto,
        key: string,
        inboxMessage: InboxMessage,
      ) {
        deliveries += 1;
        const result = await submit.execute(input, key, inboxMessage);
        if (!injectedCrash) {
          injectedCrash = true;
          throw new Error('simulated worker crash after database commit');
        }
        return result;
      },
    } as unknown as SubmitWagerTransactionUseCase;
    transactionQueueUrl = await createQueue(
      `concurrency-${randomUUID().replaceAll('-', '')}-crash.fifo`,
      { VisibilityTimeout: '1' },
    );
    const consumer = createConsumer(sqs, metrics, logger, commitThenCrash);
    withQueueUrl('WAGER_TRANSACTIONS_QUEUE_URL', transactionQueueUrl);
    consumer.onModuleInit();
    let messageId: string | undefined;
    try {
      const sent = await sqs.send(
        new SendMessageCommand({
          QueueUrl: transactionQueueUrl,
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
          MessageBody: body,
        }),
      );
      messageId = sent.MessageId;
      await waitFor(async () => {
        if (deliveries < 2) return false;
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
    if (!messageId) throw new Error('LocalStack did not return a message ID.');

    const rows = (await schema.orm.em.getConnection().execute(
      `select
        (select balance::text from "${schema.name}".wallets where id = ?) as balance,
        (select count(*)::int from "${schema.name}".wager_transactions
         where idempotency_key = ?) as transaction_count,
        (select count(*)::int from "${schema.name}".inbox_messages
         where consumer_name = 'wager-transactions' and message_id = ?) as inbox_count,
        (select count(*)::int from "${schema.name}".wallet_ledger_entries
         where wallet_id = ? and direction = 'DEBIT') as debit_count`,
      [wallet.id, idempotencyKey, messageId, wallet.id],
    )) as {
      balance: string;
      transaction_count: number;
      inbox_count: number;
      debit_count: number;
    }[];
    expect(deliveries).toBeGreaterThanOrEqual(2);
    expect(rows[0].balance).toBe('40.00');
    expect(rows[0].transaction_count).toBe(1);
    expect(rows[0].debit_count).toBe(1);
    expect(metrics.renderPrometheus()).toContain(
      'wager_retries_total{source="sqs",result="scheduled"} 1',
    );
    expect(rows[0].inbox_count).toBe(1);
  }, 30_000);

  it('uses two concurrent publishers without claiming an outbox event twice', async () => {
    await schema.orm.em.getConnection().execute(
      `update "${schema.name}".outbox_messages
       set published_at = now(), next_attempt_at = null
       where published_at is null`,
    );
    const events = Array.from({ length: 20 }, (_, index) => ({
      id: randomUUID(),
      aggregateId: randomUUID(),
      eventType: 'PublisherConcurrencyTest',
      correlationId: randomUUID(),
      causationId: null,
      version: 1,
      payload: { index },
      occurredAt: new Date(Date.now() - 1_000),
    }));
    await schema.orm.em.transactional(async (em) => {
      const repository = new MikroOrmOutboxEventRepository(em);
      for (const event of events) repository.insert(event);
    });
    withQueueUrl('WAGER_EVENTS_QUEUE_URL', eventsQueueUrl);

    const publisherClients = [
      createSqsClient(process.env.AWS_ENDPOINT_URL!),
      createSqsClient(process.env.AWS_ENDPOINT_URL!),
    ];
    const publisherLoggers = publisherClients.map(() => {
      const logger = new StructuredLogger(new RequestContext());
      return {
        logger,
        published: vi.spyOn(logger, 'info'),
        errors: vi.spyOn(logger, 'errorEvent'),
      };
    });
    const publishers = publisherClients.map(
      (client, index) =>
        new OutboxSqsPublisherWorker(
          client,
          schema.orm.em,
          new MikroOrmOutboxEventRepository(schema.orm.em.fork()),
          new MetricsService(),
          publisherLoggers[index].logger,
        ),
    );
    for (const publisher of publishers) publisher.onModuleInit();

    try {
      const eventIds = new Set(events.map(({ id }) => id));
      await waitFor(async () => {
        const rows = (await schema.orm.em.getConnection().execute(
          `select count(*)::int as count,
                  min(attempts)::int as min_attempts,
                  max(attempts)::int as max_attempts
           from "${schema.name}".outbox_messages
           where id in (${events.map(() => '?').join(', ')})
             and published_at is not null`,
          events.map(({ id }) => id),
        )) as {
          count: number;
          min_attempts: number;
          max_attempts: number;
        }[];
        return (
          rows[0]?.count === events.length &&
          rows[0].min_attempts === 1 &&
          rows[0].max_attempts === 1
        );
      });

      const receivedIds = new Set<string>();
      await waitFor(async () => {
        const response = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: eventsQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
          }),
        );
        const messages = response.Messages ?? [];
        for (const message of messages) {
          const envelope = JSON.parse(message.Body ?? 'null') as {
            eventId?: string;
          };
          if (envelope.eventId && eventIds.has(envelope.eventId)) {
            receivedIds.add(envelope.eventId);
          }
          if (message.ReceiptHandle) {
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: eventsQueueUrl,
                ReceiptHandle: message.ReceiptHandle,
              }),
            );
          }
        }
        return receivedIds.size === events.length;
      });
      expect(receivedIds.size).toBe(events.length);
      expect(
        publisherLoggers.every(({ published }) =>
          published.mock.calls.some(
            ([event]) => event === 'outbox_event_published',
          ),
        ),
      ).toBe(true);
      expect(
        publisherLoggers.flatMap(({ errors }) => errors.mock.calls),
      ).toEqual([]);
    } finally {
      await Promise.all(
        publishers.map((publisher) => publisher.onModuleDestroy()),
      );
      for (const client of publisherClients) client.destroy();
    }
  }, 30_000);

  it('processes early REFUND and ROLLBACK references and remains consistent after reconnect', async () => {
    const wallet = await createWallet('100.00');
    const refundKey = `refund-${randomUUID()}`;
    const refundReference = `missing-refund-${randomUUID()}`;
    const pendingRefund = await createSubmitUseCase().execute(
      wagerRequest(wallet, {
        kind: WagerTransactionType.REFUND,
        amount: '10.00',
        externalTransactionId: `refund-${randomUUID()}`,
        referenceExternalTransactionId: refundReference,
      }),
      refundKey,
    );
    expect(pendingRefund.status).toBe('PENDING_REFERENCE');

    const refundBet = await createSubmitUseCase().execute(
      wagerRequest(wallet, {
        externalTransactionId: refundReference,
        amount: '10.00',
      }),
      `bet-refund-${randomUUID()}`,
    );
    expect(refundBet.status).toBe('PROCESSED');
    const processedRefund = await new ProcessWagerTransactionUseCase(
      new MikroOrmWalletTransactionUnitOfWork(schema.orm.em.fork()),
    ).retryPendingReference(refundKey, new Date(Date.now() + 60_000));
    expect(processedRefund?.status).toBe('PROCESSED');

    const rollbackKey = `rollback-${randomUUID()}`;
    const rollbackReference = `missing-rollback-${randomUUID()}`;
    const pendingRollback = await createSubmitUseCase().execute(
      wagerRequest(wallet, {
        kind: WagerTransactionType.ROLLBACK,
        amount: '15.00',
        externalTransactionId: `rollback-${randomUUID()}`,
        referenceExternalTransactionId: rollbackReference,
      }),
      rollbackKey,
    );
    expect(pendingRollback.status).toBe('PENDING_REFERENCE');

    const rollbackBet = await createSubmitUseCase().execute(
      wagerRequest(wallet, {
        externalTransactionId: rollbackReference,
        amount: '15.00',
      }),
      `bet-rollback-${randomUUID()}`,
    );
    expect(rollbackBet.status).toBe('PROCESSED');
    const processedRollback = await new ProcessWagerTransactionUseCase(
      new MikroOrmWalletTransactionUnitOfWork(schema.orm.em.fork()),
    ).retryPendingReference(rollbackKey, new Date(Date.now() + 60_000));
    expect(processedRollback?.status).toBe('PROCESSED');

    await schema.orm.close(true);
    schema.orm = await MikroORM.init({
      ...mikroOrmConfig,
      schema: schema.name,
    });
    // Consulta os quatro lançamentos das apostas e suas reversões.
    const reversalLedgerRows = (await schema.orm.em.getConnection().execute(
      `select
        transaction_id as "transactionId",
        direction,
        amount::text as amount,
        reversal_of_transaction_id as "reversalOfTransactionId"
       from "${schema.name}".wallet_ledger_entries
       where wallet_id = ? and transaction_id in (?, ?, ?, ?)`,
      [wallet.id, refundBet.id, processedRefund!.id, rollbackBet.id, processedRollback!.id],
    )) as {
      transactionId: string;
      direction: string;
      amount: string;
      reversalOfTransactionId: string | null;
    }[];

    // Confirma que os quatro lançamentos foram persistidos.
    expect(reversalLedgerRows).toHaveLength(4);

    // Confirma valores, direções e vínculos das reversões.
    expect(reversalLedgerRows).toEqual(
      expect.arrayContaining([
        { transactionId: refundBet.id, direction: "DEBIT", amount: "10.00", reversalOfTransactionId: null },
        { transactionId: processedRefund!.id, direction: "CREDIT", amount: "10.00", reversalOfTransactionId: refundBet.id },
        { transactionId: rollbackBet.id, direction: "DEBIT", amount: "15.00", reversalOfTransactionId: null },
        { transactionId: processedRollback!.id, direction: "CREDIT", amount: "15.00", reversalOfTransactionId: rollbackBet.id },
      ]),
    );

    const reconciliation = await new ReconcileWalletUseCase(
      new MikroOrmWalletLedgerEntryRepository(schema.orm.em.fork()),
    ).execute(wallet.id);
    expect(reconciliation).toMatchObject({
      isConsistent: true,
      entriesVerified: 5,
    });
    expect(reconciliation?.walletBalance.toJSON().amount).toBe('100.00');
    expect(reconciliation?.difference.toJSON().amount).toBe('0.00');
  }, 30_000);

  async function createWallet(initialBalance: string) {
    return new CreateWalletUseCase(
      new MikroOrmWalletTransactionUnitOfWork(schema.orm.em.fork()),
    ).execute({
      playerId: randomUUID(),
      currency: 'BRL',
      initialBalance: Money.from({ amount: initialBalance, currency: 'BRL' }),
    });
  }

  function wagerRequest(
    wallet: { id: string; playerId: string },
    overrides: Partial<WagerTransactionRequestDto> = {},
  ): WagerTransactionRequestDto {
    return {
      providerId: 'concurrency-test',
      externalTransactionId: `external-instance-${randomUUID()}`,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'concurrency-round',
      gameId: 'concurrency-game',
      kind: WagerTransactionType.BET,
      amount: '10.00',
      currency: 'BRL',
      ...overrides,
    };
  }

  function createSubmitUseCase(
    metrics = new MetricsService(),
    logger = new StructuredLogger(new RequestContext()),
  ) {
    return new SubmitWagerTransactionUseCase(
      new ProcessWagerTransactionUseCase(
        new MikroOrmWalletTransactionUnitOfWork(schema.orm.em.fork()),
      ),
      metrics,
      logger,
    );
  }

  function createConsumer(
    client: SQSClient,
    metrics = new MetricsService(),
    logger = new StructuredLogger(new RequestContext()),
    submit = createSubmitUseCase(metrics, logger),
  ) {
    return new WagerTransactionSqsConsumer(
      client,
      schema.orm.em,
      submit,
      metrics,
      logger,
    );
  }

  async function createQueue(
    queueName: string,
    attributes: Record<string, string> = {},
  ): Promise<string> {
    const result = await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          ...attributes,
        },
      }),
    );
    if (!result.QueueUrl) {
      throw new Error(`LocalStack did not create queue ${queueName}.`);
    }
    queueNames.push(queueName);
    return result.QueueUrl;
  }

  function createSqsClient(endpoint: string): SQSClient {
    return new SQSClient({
      endpoint,
      region: process.env.AWS_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  async function waitFor(operation: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await operation()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      'Timed out waiting for concurrent service or database state.',
    );
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

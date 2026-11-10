import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '../../domain/money.js';
import {
  WagerTransaction,
  WagerTransactionType,
} from '../../domain/wager-transaction.js';
import { Wallet } from '../../domain/wallet.js';
import { mikroOrmConfig } from '../../mikro-orm.config.js';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case.js';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case.js';
import { IdempotencyConflictError } from './idempotency-conflict.error.js';
import { MikroOrmWalletTransactionUnitOfWork } from '../../infrastructure/persistence/mikro-orm-wallet-transaction.unit-of-work.js';
import { MikroOrmWalletRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import {
  name as initialName,
  up as initialUp,
} from '../../migrations/001-initial-structure.js';
import {
  name as ledgerName,
  up as ledgerUp,
} from '../../migrations/002-ledger-reversals.js';
import {
  name as walletVersionName,
  up as walletVersionUp,
} from '../../migrations/003-wallet-version-zero.js';
import {
  name as responseBalanceName,
  up as responseBalanceUp,
} from '../../migrations/004-idempotency-response-balance.js';
import {
  name as pendingReferenceRetriesName,
  up as pendingReferenceRetriesUp,
} from '../../migrations/005-pending-reference-retries.js';

const migrations = [
  { name: initialName, up: initialUp },
  { name: ledgerName, up: ledgerUp },
  { name: walletVersionName, up: walletVersionUp },
  { name: responseBalanceName, up: responseBalanceUp },
  { name: pendingReferenceRetriesName, up: pendingReferenceRetriesUp },
];

describe('Wager idempotency (PostgreSQL)', () => {
  let adminOrm: MikroORM;
  let appOrm: MikroORM;
  let schemaName: string;
  const walletId = randomUUID();
  const playerId = randomUUID();

  beforeAll(async () => {
    adminOrm = await MikroORM.init(mikroOrmConfig);
    schemaName = `idempotency_${randomUUID().replaceAll('-', '')}`;
    await adminOrm.em.getConnection().execute(`create schema "${schemaName}"`);

    appOrm = await createIsolatedOrm();
    await appOrm.em.transactional(async (em) => {
      const connection = em.getConnection();
      await connection.execute(
        `set local search_path to "${schemaName}", public`,
        [],
        'all',
        em.getTransactionContext(),
      );
      await connection.execute(
        `create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )`,
        [],
        'all',
        em.getTransactionContext(),
      );
      for (const migration of migrations) {
        for (const statement of migration.up) {
          await connection.execute(
            statement,
            [],
            'all',
            em.getTransactionContext(),
          );
        }
        await connection.execute(
          'insert into schema_migrations (name) values (?)',
          [migration.name],
          'all',
          em.getTransactionContext(),
        );
      }
    });

    const entityManager = appOrm.em.fork();
    await entityManager.transactional(async (em) => {
      const wallets = new MikroOrmWalletRepository(em);
      const wallet = Wallet.open(walletId, playerId, 'BRL');
      wallet.credit(Money.from({ amount: '100.00', currency: 'BRL' }));
      wallets.insert(wallet);
      await em.flush();
    });
  }, 30_000);

  afterAll(async () => {
    await appOrm?.close(true);
    if (adminOrm && schemaName) {
      await adminOrm.em
        .getConnection()
        .execute(`drop schema "${schemaName}" cascade`);
    }
    await adminOrm?.close(true);
  });

  it('replays sequentially and concurrently with the original balance, detects conflict, and survives restart', async () => {
    const firstKey = `replay-${randomUUID()}`;
    const firstExternalId = `external-${randomUUID()}`;
    const concurrentAttempts = Array.from({ length: 12 }, () =>
      processAttempt({
        idempotencyKey: firstKey,
        externalTransactionId: firstExternalId,
        amount: '20.00',
      }),
    );

    const concurrentResults = await Promise.all(concurrentAttempts);
    expect(new Set(concurrentResults.map(({ id }) => id)).size).toBe(1);
    expect(
      concurrentResults.every(
        ({ responseBalance }) => responseBalance?.toJSON().amount === '80.00',
      ),
    ).toBe(true);

    const sequentialReplay = await processAttempt({
      idempotencyKey: firstKey,
      externalTransactionId: firstExternalId,
      amount: '20.00',
    });
    expect(sequentialReplay.id).toBe(concurrentResults[0].id);
    expect(sequentialReplay.responseBalance?.toJSON().amount).toBe('80.00');
    expect(await ledgerEntryCount(concurrentResults[0].id)).toBe(1);

    const laterTransaction = await processAttempt({
      idempotencyKey: `later-${randomUUID()}`,
      externalTransactionId: `external-${randomUUID()}`,
      amount: '5.00',
    });
    expect(laterTransaction.responseBalance?.toJSON().amount).toBe('75.00');

    await expect(
      processAttempt({
        idempotencyKey: firstKey,
        externalTransactionId: firstExternalId,
        amount: '21.00',
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await walletBalance()).toBe('75.00');
    expect(await ledgerEntryCount(concurrentResults[0].id)).toBe(1);

    await appOrm.close(true);
    appOrm = await createIsolatedOrm();

    const replayAfterRestart = await processAttempt({
      idempotencyKey: firstKey,
      externalTransactionId: firstExternalId,
      amount: '20.00',
    });
    expect(replayAfterRestart.id).toBe(concurrentResults[0].id);
    expect(replayAfterRestart.responseBalance?.toJSON().amount).toBe('80.00');
    expect(await walletBalance()).toBe('75.00');
  }, 30_000);

  it('commits inbox deduplication atomically with the financial operation', async () => {
    const balanceBefore = await walletBalance();
    const submit = new SubmitWagerTransactionUseCase(
      new ProcessWagerTransactionUseCase(
        new MikroOrmWalletTransactionUnitOfWork(appOrm.em.fork()),
      ),
    );
    const input = {
      providerId: 'inbox-test-provider',
      externalTransactionId: `external-${randomUUID()}`,
      walletId,
      playerId,
      roundId: 'inbox-test-round',
      gameId: 'inbox-test-game',
      kind: WagerTransactionType.BET,
      amount: '10.00',
      currency: 'BRL',
    } as const;
    const idempotencyKey = `queue-${randomUUID()}`;
    const inboxMessage = {
      consumerName: 'wager-transactions',
      messageId: randomUUID(),
      payloadHash: 'a'.repeat(64),
    };

    const first = await submit.execute(input, idempotencyKey, inboxMessage);
    const redelivery = await submit.execute(
      input,
      idempotencyKey,
      inboxMessage,
    );

    expect(first).not.toBeNull();
    expect(redelivery).toBeNull();
    expect(await walletBalance()).toBe(
      Money.from({ amount: balanceBefore, currency: 'BRL' })
        .subtract(Money.from({ amount: '10.00', currency: 'BRL' }))
        .toJSON().amount,
    );
    const inboxRows = (await appOrm.em.getConnection().execute(
      `select payload_hash, processed_at from "${schemaName}".inbox_messages
       where consumer_name = ? and message_id = ?`,
      [inboxMessage.consumerName, inboxMessage.messageId],
    )) as { payload_hash: string; processed_at: Date | null }[];
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0].payload_hash).toBe(inboxMessage.payloadHash);
    expect(inboxRows[0].processed_at).not.toBeNull();

    await expect(
      submit.execute(input, idempotencyKey, {
        ...inboxMessage,
        payloadHash: 'b'.repeat(64),
      }),
    ).rejects.toThrow();

    const failedMessage = {
      consumerName: 'wager-transactions',
      messageId: randomUUID(),
      payloadHash: 'c'.repeat(64),
    };
    await expect(
      submit.execute(
        { ...input, walletId: randomUUID() },
        `queue-${randomUUID()}`,
        failedMessage,
      ),
    ).rejects.toThrow();
    const failedInboxRows = (await appOrm.em.getConnection().execute(
      `select message_id from "${schemaName}".inbox_messages
       where consumer_name = ? and message_id = ?`,
      [failedMessage.consumerName, failedMessage.messageId],
    )) as { message_id: string }[];
    expect(failedInboxRows).toHaveLength(0);
  }, 30_000);

  function processAttempt(input: {
    idempotencyKey: string;
    externalTransactionId: string;
    amount: string;
  }): Promise<WagerTransaction> {
    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: 'idempotency-test-provider',
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: '0'.repeat(64),
      walletId,
      playerId,
      roundId: 'idempotency-test-round',
      gameId: 'idempotency-test-game',
      kind: WagerTransactionType.BET,
      amount: Money.from({ amount: input.amount, currency: 'BRL' }),
      currency: 'BRL',
    });
    const unitOfWork = new MikroOrmWalletTransactionUnitOfWork(
      appOrm.em.fork(),
    );
    return new ProcessWagerTransactionUseCase(unitOfWork).execute(transaction);
  }

  async function walletBalance(): Promise<string> {
    const wallet = await new MikroOrmWalletRepository(
      appOrm.em.fork(),
    ).findById(walletId);
    if (!wallet) throw new Error('A wallet de teste não foi encontrada.');
    return wallet.balance.toJSON().amount;
  }

  async function ledgerEntryCount(transactionId: string): Promise<number> {
    const result = await appOrm.em
      .getConnection()
      .execute(
        `select count(*)::int as count from "${schemaName}".wallet_ledger_entries where transaction_id = ?`,
        [transactionId],
      );
    const rows = result as { count: number }[];
    return rows[0].count;
  }

  function createIsolatedOrm(): Promise<MikroORM> {
    return MikroORM.init({ ...mikroOrmConfig, schema: schemaName });
  }
});

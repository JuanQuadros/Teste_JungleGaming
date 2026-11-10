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
import { IdempotencyConflictError } from './idempotency-conflict.error.js';
import { MikroOrmWalletTransactionUnitOfWork } from '../../infrastructure/persistence/mikro-orm-wallet-transaction.unit-of-work.js';
import { MikroOrmWalletRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { name as initialName, up as initialUp } from '../../migrations/001-initial-structure.js';
import { name as ledgerName, up as ledgerUp } from '../../migrations/002-ledger-reversals.js';
import { name as walletVersionName, up as walletVersionUp } from '../../migrations/003-wallet-version-zero.js';
import { name as responseBalanceName, up as responseBalanceUp } from '../../migrations/004-idempotency-response-balance.js';

const migrations = [
  { name: initialName, up: initialUp },
  { name: ledgerName, up: ledgerUp },
  { name: walletVersionName, up: walletVersionUp },
  { name: responseBalanceName, up: responseBalanceUp },
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
    await adminOrm.em
      .getConnection()
      .execute(`create schema "${schemaName}"`);

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
      await adminOrm
        .em.getConnection()
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
    const result = await appOrm.em.getConnection().execute(
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

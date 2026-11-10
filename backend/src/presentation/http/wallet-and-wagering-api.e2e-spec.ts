import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  WALLET_CREATION_UNIT_OF_WORK,
  WALLET_LEDGER_ENTRY_REPOSITORY,
  WALLET_REPOSITORY,
  WALLET_TRANSACTION_UNIT_OF_WORK,
  WAGER_TRANSACTION_REPOSITORY,
} from '../../application/ports/persistence.repositories.js';
import { CreateWalletUseCase } from '../../application/wallet-management/create-wallet.use-case.js';
import { ProcessWagerTransactionUseCase } from '../../application/wager-processing/process-wager-transaction.use-case.js';
import { SubmitWagerTransactionUseCase } from '../../application/wager-processing/submit-wager-transaction.use-case.js';
import { RetryPendingReferencesUseCase } from '../../application/wager-processing/retry-pending-references.use-case.js';
import { mikroOrmConfig } from '../../mikro-orm.config.js';
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
import { RequestContext } from '../../observability/request-context.js';
import { StructuredLogger } from '../../observability/structured-logger.js';
import { MikroOrmWalletTransactionUnitOfWork } from '../../infrastructure/persistence/mikro-orm-wallet-transaction.unit-of-work.js';
import { MikroOrmWalletLedgerEntryRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wallet-ledger-entry.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletRepository } from '../../infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';
import { HttpExceptionFilter } from './http-exception.filter.js';
import { WageringTransactionsController } from './wagering-transactions.controller.js';
import { WalletsController } from './wallets.controller.js';

const migrations = [
  initialUp,
  ledgerUp,
  walletVersionUp,
  responseBalanceUp,
  pendingReferenceRetriesUp,
];

describe('Wallet and wagering HTTP API (PostgreSQL)', () => {
  let adminOrm: MikroORM;
  let appOrm: MikroORM;
  let app: INestApplication;
  let schemaName: string;

  beforeAll(async () => {
    adminOrm = await MikroORM.init(mikroOrmConfig);
    schemaName = `wallet_api_${randomUUID().replaceAll('-', '')}`;
    await adminOrm.em.getConnection().execute(`create schema "${schemaName}"`);
    appOrm = await MikroORM.init({ ...mikroOrmConfig, schema: schemaName });
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
      const names = [
        initialName,
        ledgerName,
        walletVersionName,
        responseBalanceName,
        pendingReferenceRetriesName,
      ];
      for (const [index, statements] of migrations.entries()) {
        for (const statement of statements) {
          await connection.execute(
            statement,
            [],
            'all',
            em.getTransactionContext(),
          );
        }
        await connection.execute(
          'insert into schema_migrations (name) values (?)',
          [names[index]],
          'all',
          em.getTransactionContext(),
        );
      }
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [WalletsController, WageringTransactionsController],
      providers: [
        CreateWalletUseCase,
        ProcessWagerTransactionUseCase,
        SubmitWagerTransactionUseCase,
        RetryPendingReferencesUseCase,
        {
          provide: WALLET_CREATION_UNIT_OF_WORK,
          useFactory: () =>
            new MikroOrmWalletTransactionUnitOfWork(appOrm.em.fork()),
        },
        {
          provide: WALLET_TRANSACTION_UNIT_OF_WORK,
          useFactory: () =>
            new MikroOrmWalletTransactionUnitOfWork(appOrm.em.fork()),
        },
        {
          provide: WALLET_REPOSITORY,
          useFactory: () => new MikroOrmWalletRepository(appOrm.em.fork()),
        },
        {
          provide: WAGER_TRANSACTION_REPOSITORY,
          useFactory: () =>
            new MikroOrmWagerTransactionRepository(appOrm.em.fork()),
        },
        {
          provide: WALLET_LEDGER_ENTRY_REPOSITORY,
          useFactory: () =>
            new MikroOrmWalletLedgerEntryRepository(appOrm.em.fork()),
        },
        RequestContext,
        StructuredLogger,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    const logger = app.get(StructuredLogger);
    vi.spyOn(logger, 'errorEvent').mockImplementation(() => {});
    app.useGlobalFilters(
      new HttpExceptionFilter(app.get(RequestContext), logger),
    );
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await appOrm?.close(true);
    if (adminOrm && schemaName) {
      await adminOrm.em
        .getConnection()
        .execute(`drop schema "${schemaName}" cascade`);
    }
    await adminOrm?.close(true);
  });

  it('creates wallets and atomically records an initial OPENING', async () => {
    const playerId = randomUUID();
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, currency: 'BRL', initialBalance: '50.00' })
      .expect(201);
    expect(response.body).toMatchObject({
      playerId,
      currency: 'BRL',
      balance: '50.00',
      version: 1,
    });

    const page = await request(app.getHttpServer())
      .get(`/wallets/${response.body.walletId}/ledger`)
      .expect(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0]).toMatchObject({
      direction: 'CREDIT',
      amount: '50.00',
      balanceBefore: '0.00',
      balanceAfter: '50.00',
    });
    const opening = await request(app.getHttpServer())
      .get(`/wagering/transactions/${page.body.items[0].transactionId}`)
      .expect(200);
    expect(opening.body).toMatchObject({
      kind: 'OPENING',
      status: 'PROCESSED',
      balance: '50.00',
    });

    await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, currency: 'BRL' })
      .expect(409)
      .expect(({ body }) => {
        expect(body.error.code).toBe('WALLET_ALREADY_EXISTS');
      });

    const emptyWallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId: randomUUID(), currency: 'BRL' })
      .expect(201);
    expect(emptyWallet.body).toMatchObject({ balance: '0.00', version: 0 });
    const emptyLedger = await request(app.getHttpServer())
      .get(`/wallets/${emptyWallet.body.walletId}/ledger`)
      .expect(200);
    expect(emptyLedger.body).toEqual({ items: [], nextCursor: null });
  });

  it('submits idempotently and supports wallet, ledger, and transaction lookups', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, currency: 'BRL', initialBalance: '50.00' })
      .expect(201);
    const firstBody = transactionBody(wallet.body.walletId, playerId, '10.00');
    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'api-bet-1')
      .send(firstBody)
      .expect(200);
    expect(first.body).toMatchObject({
      status: 'PROCESSED',
      code: 'PROCESSED',
      balance: '40.00',
    });

    const replay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'api-bet-1')
      .send(firstBody)
      .expect(200);
    expect(replay.body).toEqual(first.body);

    const second = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'api-bet-2')
      .send(transactionBody(wallet.body.walletId, playerId, '5.00'))
      .expect(200);
    expect(second.body.balance).toBe('35.00');

    const walletState = await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.walletId}`)
      .expect(200);
    expect(walletState.body).toMatchObject({
      balance: '35.00',
      version: 3,
    });

    const transactionById = await request(app.getHttpServer())
      .get(`/wagering/transactions/${first.body.transactionId}`)
      .expect(200);
    const transactionByExternalId = await request(app.getHttpServer())
      .get('/wagering/transactions/by-external')
      .query({
        providerId: firstBody.providerId,
        externalTransactionId: firstBody.externalTransactionId,
      })
      .expect(200);
    expect(transactionByExternalId.body).toEqual(transactionById.body);

    const firstPage = await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.walletId}/ledger`)
      .query({ limit: 2 })
      .expect(200);
    expect(firstPage.body.items).toHaveLength(2);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));
    const secondPage = await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.walletId}/ledger`)
      .query({ limit: 2, cursor: firstPage.body.nextCursor })
      .expect(200);
    expect(secondPage.body.items).toHaveLength(1);
    expect(secondPage.body.nextCursor).toBeNull();
    const entryIds = [...firstPage.body.items, ...secondPage.body.items].map(
      ({ entryId }: { entryId: string }) => entryId,
    );
    expect(new Set(entryIds).size).toBe(3);
  });

  it('rejects invalid requests and conflicting reuse of the idempotency key', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, currency: 'BRL', initialBalance: '20.00' })
      .expect(201);
    const body = transactionBody(wallet.body.walletId, playerId, '5.00');
    const key = `conflict-${randomUUID()}`;
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send({ ...body, amount: '6.00' })
      .expect(409)
      .expect(({ body: errorBody }) => {
        expect(errorBody.error.code).toBe('IDEMPOTENCY_CONFLICT');
      });

    await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: randomUUID(),
        currency: 'BRL',
        initialBalance: '-1.00',
      })
      .expect(400);
    await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.walletId}/ledger`)
      .query({ limit: 101 })
      .expect(400);
    await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.walletId}/ledger`)
      .query({ cursor: 'not-a-cursor' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .send(body)
      .expect(400)
      .expect(({ body: errorBody }) => {
        expect(errorBody.error.code).toBe('INVALID_REQUEST');
        expect(errorBody.error.details).toContainEqual(
          expect.objectContaining({
            field: 'Idempotency-Key',
            code: 'INVALID_IDEMPOTENCY_KEY',
          }),
        );
      });

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'invalid-reference-shapes')
      .send({
        ...body,
        walletId: 'not-a-uuid',
        referenceExternalTransactionId: 'external-ref',
        referenceTransactionId: randomUUID(),
      })
      .expect(400)
      .expect(({ body: errorBody }) => {
        expect(errorBody.error.details).toContainEqual(
          expect.objectContaining({ field: 'walletId', code: 'INVALID_UUID' }),
        );
        expect(errorBody.error.details).toContainEqual(
          expect.objectContaining({
            field: 'reference',
            code: 'REFERENCE_MUST_BE_UNAMBIGUOUS',
          }),
        );
      });
  });

  it('maps insufficient balance to 422 and missing references to 202', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, currency: 'BRL' })
      .expect(201);
    const betBody = transactionBody(wallet.body.walletId, playerId, '0.01');

    const rejected = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `insufficient-${randomUUID()}`)
      .send(betBody)
      .expect(422);
    expect(rejected.body).toMatchObject({
      status: 'REJECTED',
      code: 'INSUFFICIENT_BALANCE',
      balance: '0.00',
    });

    const persistedRejected = await request(app.getHttpServer())
      .get(`/wagering/transactions/${rejected.body.transactionId}`)
      .expect(200);
    expect(persistedRejected.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_BALANCE',
      balance: '0.00',
    });

    const pendingBody = {
      ...transactionBody(wallet.body.walletId, playerId, '1.00'),
      kind: 'REFUND',
      referenceExternalTransactionId: `not-arrived-${randomUUID()}`,
    };
    const pendingKey = `pending-${randomUUID()}`;
    const pending = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', pendingKey)
      .send(pendingBody)
      .expect(202);
    expect(pending.body).toMatchObject({
      status: 'PENDING_REFERENCE',
      code: 'PROCESSING_PENDING',
      balance: '0.00',
    });

    const replay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', pendingKey)
      .send(pendingBody)
      .expect(202);
    expect(replay.body).toEqual(pending.body);
  });

  it('resolves an out-of-order refund once its reference is processed', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, currency: 'BRL', initialBalance: '50.00' })
      .expect(201);
    const referenceExternalTransactionId = `late-reference-${randomUUID()}`;
    const refundBody = {
      ...transactionBody(wallet.body.walletId, playerId, '10.00'),
      kind: 'REFUND',
      referenceExternalTransactionId,
    };
    const refundKey = `out-of-order-refund-${randomUUID()}`;
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', refundKey)
      .send(refundBody)
      .expect(202);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `late-bet-${randomUUID()}`)
      .send({
        ...transactionBody(wallet.body.walletId, playerId, '10.00'),
        externalTransactionId: referenceExternalTransactionId,
        kind: 'BET',
      })
      .expect(200);

    const retry = app.get(RetryPendingReferencesUseCase);
    expect(await retry.execute(new Date(Date.now() + 10_000))).toBeGreaterThan(
      0,
    );
    const resolved = await request(app.getHttpServer())
      .get('/wagering/transactions/by-external')
      .query({
        providerId: refundBody.providerId,
        externalTransactionId: refundBody.externalTransactionId,
      })
      .expect(200);
    expect(resolved.body).toMatchObject({
      status: 'PROCESSED',
      balance: '50.00',
    });

    const walletAfterRetry = await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.walletId}`)
      .expect(200);
    expect(walletAfterRetry.body.balance).toBe('50.00');
    const ledger = await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.walletId}/ledger`)
      .expect(200);
    expect(ledger.body.items).toHaveLength(3);
    expect(
      ledger.body.items.filter(
        ({
          reversalOfTransactionId,
        }: {
          reversalOfTransactionId: string | null;
        }) => reversalOfTransactionId !== null,
      ),
    ).toHaveLength(1);
    await retry.execute(new Date(Date.now() + 20_000));
    const ledgerAfterReplay = await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.walletId}/ledger`)
      .expect(200);
    expect(ledgerAfterReplay.body.items).toHaveLength(3);
  });

  it('rejects a late reference from another round without applying a reversal', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, currency: 'BRL', initialBalance: '20.00' })
      .expect(201);
    const referenceExternalTransactionId = `wrong-round-reference-${randomUUID()}`;
    const refundBody = {
      ...transactionBody(wallet.body.walletId, playerId, '5.00'),
      kind: 'REFUND',
      roundId: 'refund-round',
      referenceExternalTransactionId,
    };
    const refund = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `wrong-round-refund-${randomUUID()}`)
      .send(refundBody)
      .expect(202);

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `wrong-round-bet-${randomUUID()}`)
      .send({
        ...transactionBody(wallet.body.walletId, playerId, '5.00'),
        externalTransactionId: referenceExternalTransactionId,
        roundId: 'different-round',
      })
      .expect(200);
    await app
      .get(RetryPendingReferencesUseCase)
      .execute(new Date(Date.now() + 10_000));

    const rejected = await request(app.getHttpServer())
      .get(`/wagering/transactions/${refund.body.transactionId}`)
      .expect(200);
    expect(rejected.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INVALID_REFERENCE',
    });
    const ledger = await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.walletId}/ledger`)
      .expect(200);
    expect(ledger.body.items).toHaveLength(2);
    expect(
      ledger.body.items.every(
        ({
          reversalOfTransactionId,
        }: {
          reversalOfTransactionId: string | null;
        }) => reversalOfTransactionId === null,
      ),
    ).toBe(true);
  });

  it('rejects an unresolved reference after five retries and records one outbox event', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId, currency: 'BRL', initialBalance: '25.00' })
      .expect(201);
    const body = {
      ...transactionBody(wallet.body.walletId, playerId, '5.00'),
      kind: 'REFUND',
      referenceExternalTransactionId: `never-arrived-${randomUUID()}`,
    };
    const key = `expired-reference-${randomUUID()}`;
    const pending = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(202);

    const retry = app.get(RetryPendingReferencesUseCase);
    let now = new Date(Date.now() + 10_000);
    const parallelRetries = await Promise.all([
      retry.execute(now),
      retry.execute(now),
    ]);
    expect(parallelRetries.every((count) => count > 0)).toBe(true);
    const attemptRows = await appOrm.em.getConnection().execute(
      `select reference_attempts as attempts
       from "${schemaName}".wager_transactions
       where id = ?`,
      [pending.body.transactionId],
    );
    const attemptsAfterParallelRetry = attemptRows as { attempts: number }[];
    expect(attemptsAfterParallelRetry[0].attempts).toBe(1);
    now = new Date(now.getTime() + 100_000);
    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect(await retry.execute(now)).toBeGreaterThan(0);
      now = new Date(now.getTime() + 100_000);
    }

    const rejected = await request(app.getHttpServer())
      .get(`/wagering/transactions/${pending.body.transactionId}`)
      .expect(200);
    expect(rejected.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
      balance: '25.00',
    });
    const rejectionReplay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(422);
    expect(rejectionReplay.body).toMatchObject({
      code: 'REFERENCE_NOT_FOUND',
      status: 'REJECTED',
      balance: '25.00',
    });
    const ledger = await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.walletId}/ledger`)
      .expect(200);
    expect(ledger.body.items).toHaveLength(1);

    const outboxResult = await appOrm.em.getConnection().execute(
      `select count(*)::int as count
       from "${schemaName}".outbox_messages
       where aggregate_id = ? and event_type = ?`,
      [pending.body.transactionId, 'WagerTransactionReferenceExpired'],
    );
    const outboxRows = outboxResult as { count: number }[];
    expect(outboxRows[0].count).toBe(1);
    expect(await retry.execute(now)).toBe(0);
  });

  function transactionBody(walletId: string, playerId: string, amount: string) {
    return {
      providerId: 'api-test-provider',
      externalTransactionId: `external-${randomUUID()}`,
      walletId,
      playerId,
      roundId: 'api-test-round',
      gameId: 'api-test-game',
      kind: 'BET',
      amount,
      currency: 'BRL',
    };
  }
});

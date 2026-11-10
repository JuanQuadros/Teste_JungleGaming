import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mikroOrmConfig } from '../../mikro-orm.config.js';
import {
  name as initialMigrationName,
  up as initialMigration,
} from '../../migrations/001-initial-structure.js';
import { up as versionedOutboxMigration } from '../../migrations/009-versioned-outbox-events.js';
import { MikroOrmOutboxEventRepository } from './repositories/mikro-orm-outbox-event.repository.js';

describe('Transactional outbox repository (PostgreSQL)', () => {
  let adminOrm: MikroORM;
  let appOrm: MikroORM;
  let schemaName: string;

  beforeAll(async () => {
    adminOrm = await MikroORM.init(mikroOrmConfig);
    schemaName = `outbox_${randomUUID().replaceAll('-', '')}`;
    await adminOrm.em.getConnection().execute(`create schema "${schemaName}"`);
    appOrm = await MikroORM.init({ ...mikroOrmConfig, schema: schemaName });
    await appOrm.em.transactional(async (em) => {
      await em
        .getConnection()
        .execute(
          `set local search_path to "${schemaName}", public`,
          [],
          'all',
          em.getTransactionContext(),
        );
      for (const statement of initialMigration) {
        await em
          .getConnection()
          .execute(statement, [], 'all', em.getTransactionContext());
      }
      for (const statement of versionedOutboxMigration) {
        await em
          .getConnection()
          .execute(statement, [], 'all', em.getTransactionContext());
      }
      await em.getConnection().execute(
        `create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )`,
        [],
        'all',
        em.getTransactionContext(),
      );
      await em
        .getConnection()
        .execute(
          'insert into schema_migrations (name) values (?)',
          [initialMigrationName],
          'all',
          em.getTransactionContext(),
        );
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

  it('claims disjoint events, preserves aggregate ordering, and persists retry/publication state', async () => {
    const now = new Date();
    const aggregateA = randomUUID();
    const aggregateB = randomUUID();
    const firstA = createEvent(aggregateA, new Date(now.getTime() - 3_000));
    const secondA = createEvent(aggregateA, new Date(now.getTime() - 2_000));
    const firstB = createEvent(aggregateB, new Date(now.getTime() - 1_000));
    await appOrm.em.transactional(async (em) => {
      const repository = new MikroOrmOutboxEventRepository(em);
      repository.insert(firstA);
      repository.insert(secondA);
      repository.insert(firstB);
    });

    const firstRepository = new MikroOrmOutboxEventRepository(appOrm.em.fork());
    const secondRepository = new MikroOrmOutboxEventRepository(
      appOrm.em.fork(),
    );
    const claims = await Promise.all([
      firstRepository.claimDue(now, new Date(now.getTime() + 60_000), 10),
      secondRepository.claimDue(now, new Date(now.getTime() + 60_000), 10),
    ]);
    const claimedIds = claims.flat().map(({ id }) => id);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds).toContain(firstA.id);
    expect(claimedIds).toContain(firstB.id);
    expect(claimedIds).not.toContain(secondA.id);

    const firstAClaim = claims.flat().find(({ id }) => id === firstA.id);
    const firstBClaim = claims.flat().find(({ id }) => id === firstB.id);
    expect(firstAClaim?.attempts).toBe(1);
    expect(
      await firstRepository.scheduleRetry(
        firstA.id,
        1,
        new Date(now.getTime() + 5_000),
      ),
    ).toBe(true);
    expect(await firstRepository.markPublished(firstB.id, 1, new Date())).toBe(
      true,
    );

    const retriedFirstA = await firstRepository.claimDue(
      new Date(now.getTime() + 6_000),
      new Date(now.getTime() + 66_000),
      10,
    );
    expect(retriedFirstA.map(({ id }) => id)).toEqual([firstA.id]);
    expect(retriedFirstA[0].attempts).toBe(2);
    expect(await firstRepository.markPublished(firstA.id, 2, new Date())).toBe(
      true,
    );
    const secondAClaim = await firstRepository.claimDue(
      new Date(now.getTime() + 6_000),
      new Date(now.getTime() + 66_000),
      10,
    );
    expect(secondAClaim.map(({ id }) => id)).toEqual([secondA.id]);
    expect(await firstRepository.markPublished(secondA.id, 1, new Date())).toBe(
      true,
    );
    expect(firstBClaim?.attempts).toBe(1);

    const rows = (await appOrm.em.getConnection().execute(
      `select id, attempts, next_attempt_at, published_at
       from "${schemaName}".outbox_messages
       where id in (?, ?, ?)`,
      [firstA.id, secondA.id, firstB.id],
    )) as Array<{
      id: string;
      attempts: number;
      next_attempt_at: Date | null;
      published_at: Date | null;
    }>;
    expect(rows).toHaveLength(3);
    expect(rows.every(({ published_at }) => published_at !== null)).toBe(true);
    expect(rows.find(({ id }) => id === firstA.id)?.attempts).toBe(2);
  }, 30_000);

  function createEvent(aggregateId: string, occurredAt: Date) {
    return {
      id: randomUUID(),
      aggregateId,
      eventType: 'TestEvent',
      correlationId: randomUUID(),
      causationId: randomUUID(),
      version: 1,
      payload: { value: 'test' },
      occurredAt,
    };
  }
});

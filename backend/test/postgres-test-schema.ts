import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { mikroOrmConfig } from '../src/mikro-orm.config.js';
import { migrations } from '../src/migrations/migration-set.js';

export interface PostgresTestSchema {
  adminOrm: MikroORM;
  orm: MikroORM;
  name: string;
  migrateUp(): Promise<void>;
  migrateDown(): Promise<void>;
  close(): Promise<void>;
}

export async function createPostgresTestSchema(
  prefix: string,
): Promise<PostgresTestSchema> {
  const adminOrm = await MikroORM.init(mikroOrmConfig);
  const name = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  let orm: MikroORM | undefined;

  try {
    await adminOrm.em.getConnection().execute(`create schema "${name}"`);
    created = true;
    orm = await MikroORM.init({ ...mikroOrmConfig, schema: name });
  } catch (error) {
    await orm?.close(true);
    if (created) {
      await adminOrm.em
        .getConnection()
        .execute(`drop schema "${name}" cascade`);
    }
    await adminOrm.close(true);
    throw error;
  }

  const testSchema: PostgresTestSchema = {
    adminOrm,
    orm,
    name,
    migrateUp: () => migrate('up'),
    migrateDown: () => migrate('down'),
    async close() {
      await orm.close(true);
      await adminOrm.em
        .getConnection()
        .execute(`drop schema "${name}" cascade`);
      await adminOrm.close(true);
    },
  };
  return testSchema;

  async function migrate(direction: 'up' | 'down'): Promise<void> {
    await orm!.em.transactional(async (em) => {
      const connection = em.getConnection();
      const execute = (sql: string, parameters: unknown[] = []) =>
        connection.execute(sql, parameters, 'all', em.getTransactionContext());
      await execute(`set local search_path to "${name}", public`);
      await execute('select pg_advisory_xact_lock(?)', [741_904_202]);
      await execute(`create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);

      if (direction === 'up') {
        for (const migration of migrations) {
          const result = await execute(
            'select name from schema_migrations where name = ?',
            [migration.name],
          );
          if ((result as { name: string }[]).length > 0) continue;
          for (const statement of migration.up) await execute(statement);
          await execute('insert into schema_migrations (name) values (?)', [
            migration.name,
          ]);
        }
        return;
      }

      for (const migration of [...migrations].reverse()) {
        const result = await execute(
          'select name from schema_migrations where name = ?',
          [migration.name],
        );
        if ((result as { name: string }[]).length === 0) continue;
        for (const statement of migration.down) await execute(statement);
        await execute('delete from schema_migrations where name = ?', [
          migration.name,
        ]);
        return;
      }
    });
  }
}

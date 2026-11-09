import { MikroORM } from '@mikro-orm/postgresql';
import { mikroOrmConfig } from '../mikro-orm.config.js';
import { down, name, up } from './001-initial-structure.js';

const migrationLock = 741_904_202;

// Run one versioned migration at a time and keep its SQL plus registry update atomic.
async function run(direction: 'up' | 'down') {
  const orm = await MikroORM.init(mikroOrmConfig);

  try {
    await orm.em.transactional(async (em) => {
      const connection = em.getConnection();
      // Pass the active transaction context to every raw SQL statement.
      const execute = (sql: string, params: unknown[] = []) =>
        connection.execute(sql, params, 'all', em.getTransactionContext());

      // This transaction-scoped lock prevents two app instances from migrating together.
      await execute('select pg_advisory_xact_lock(?)', [migrationLock]);
      await execute(`
        create table if not exists schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `);

      // The registry makes applying the same migration repeatedly safe.
      const result = await execute(
        'select name from schema_migrations where name = ?',
        [name],
      );
      const rows = result as unknown as { name: string }[];
      const applied = rows.length > 0;

      if (direction === 'up' && !applied) {
        for (const statement of up) await execute(statement);
        await execute('insert into schema_migrations (name) values (?)', [name]);
        console.info(`Applied ${name}`);
      } else if (direction === 'down' && applied) {
        for (const statement of down) await execute(statement);
        await execute('delete from schema_migrations where name = ?', [name]);
        console.info(`Reverted ${name}`);
      } else {
        console.info(`No migration to ${direction}`);
      }
    });
  } finally {
    await orm.close(true);
  }
}

const direction = process.argv[2] === 'down' ? 'down' : 'up';
await run(direction);

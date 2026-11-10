import { MikroORM } from '@mikro-orm/postgresql';
import { mikroOrmConfig } from '../mikro-orm.config.js';
import { migrations } from './migration-set.js';

const migrationLock = 741_904_202;

// Executa uma migration versionada por vez e mantém o SQL e o registro na mesma transação.
async function run(direction: 'up' | 'down') {
  const orm = await MikroORM.init(mikroOrmConfig);

  try {
    await orm.em.transactional(async (em) => {
      const connection = em.getConnection();
      // Encaminha o contexto da transação ativa para cada comando SQL.
      const execute = (sql: string, params: unknown[] = []) =>
        connection.execute(sql, params, 'all', em.getTransactionContext());

      // Este bloqueio transacional impede duas instâncias de executar migrations ao mesmo tempo.
      await execute('select pg_advisory_xact_lock(?)', [migrationLock]);
      await execute(`
        create table if not exists schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `);

      if (direction === 'up') {
        for (const migration of migrations) {
          const result = await execute(
            'select name from schema_migrations where name = ?',
            [migration.name],
          );
          const rows = result as unknown as { name: string }[];
          if (rows.length > 0) continue;

          for (const statement of migration.up) await execute(statement);
          await execute('insert into schema_migrations (name) values (?)', [
            migration.name,
          ]);
          console.info(`Applied ${migration.name}`);
        }
      } else {
        for (const migration of [...migrations].reverse()) {
          const result = await execute(
            'select name from schema_migrations where name = ?',
            [migration.name],
          );
          const rows = result as unknown as { name: string }[];
          if (rows.length === 0) continue;

          for (const statement of migration.down) await execute(statement);
          await execute('delete from schema_migrations where name = ?', [
            migration.name,
          ]);
          console.info(`Reverted ${migration.name}`);
          return;
        }
        console.info(`No migration to ${direction}`);
      }
    });
  } finally {
    await orm.close(true);
  }
}

const direction = process.argv[2] === 'down' ? 'down' : 'up';
await run(direction);

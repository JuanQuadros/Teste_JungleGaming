
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPostgresTestSchema,
  type PostgresTestSchema,
} from '../../test/postgres-test-schema.js';

describe('Database migrations (PostgreSQL)', () => {
  let schema: PostgresTestSchema;

  beforeAll(async () => {
    schema = await createPostgresTestSchema('migration_test');
    await schema.migrateUp();
  }, 30_000);

  afterAll(async () => {
    await schema?.close();
  });

  it('applies all migrations, enforces constraints, and rolls them back in reverse order', async () => {
    // Confere se todas as migrations, inclusive a 010, foram aplicadas.
    const migrationRows = (await schema.orm.em
      .getConnection()
      .execute(
        `select name from "${schema.name}".schema_migrations order by name`,
      )) as { name: string }[];

    expect(migrationRows.map(({ name }) => name)).toEqual([
      '001-initial-structure',
      '002-ledger-reversals',
      '003-wallet-version-zero',
      '004-idempotency-response-balance',
      '005-pending-reference-retries',
      '006-wallet-version-one',
      '007-wallet-ledger-balance-consistency',
      '008-ledger-truncate-protection',
      '009-versioned-outbox-events',
      '010-transaction-terminal-timestamps',
    ]);

    // Confere se uma carteira nova começa com versão 1.
    const newWallet = (await schema.orm.em.getConnection().execute(
      `insert into "${schema.name}".wallets (player_id, currency)
       values (?, 'BRL')
       returning version`,
      ['00000000-0000-4000-8000-000000000012'],
    )) as { version: number }[];

    expect(newWallet[0].version).toBe(1);

    // A trigger deve impedir divergência entre saldo e ledger.
    await expect(
      schema.orm.em.transactional(async (em) => {
        await em.getConnection().execute(
          `update "${schema.name}".wallets
           set balance = 1.00
           where player_id = ?`,
          ['00000000-0000-4000-8000-000000000012'],
          'all',
          em.getTransactionContext(),
        );
      }),
    ).rejects.toThrow('balance does not match its ledger');

    // A versão zero não pode ser inserida após as migrations correspondentes.
    await expect(
      schema.orm.em.getConnection().execute(
        `insert into "${schema.name}".wallets (player_id, currency, version)
         values (?, 'BRL', 0)`,
        ['00000000-0000-4000-8000-000000000013'],
      ),
    ).rejects.toThrow();

    // O ledger deve continuar protegido contra exclusão em massa.
    await expect(
      schema.orm.em
        .getConnection()
        .execute(`truncate table "${schema.name}".wallet_ledger_entries`),
    ).rejects.toThrow('wallet ledger entries are immutable');

    // Reverte as migrations 010, 009, 008, 007 e 006.
    for (let index = 0; index < 5; index += 1) {
      await schema.migrateDown();
    }

    // Insere uma carteira com versão zero enquanto a migration 006 está revertida.
    await schema.orm.em.getConnection().execute(
      `insert into "${schema.name}".wallets (id, player_id, currency, version)
       values (?, ?, 'BRL', 0)`,
      [
        '00000000-0000-4000-8000-000000000014',
        '00000000-0000-4000-8000-000000000015',
      ],
    );

    // Reaplica as migrations 006 a 010.
    await schema.migrateUp();

    const upgradedWallet = (await schema.orm.em.getConnection().execute(
      `select version from "${schema.name}".wallets
         where id = '00000000-0000-4000-8000-000000000014'`,
    )) as { version: number }[];

    expect(upgradedWallet[0].version).toBe(1);

    // A migration deve continuar rejeitando moedas inválidas.
    await expect(
      schema.orm.em.transactional(async (em) => {
        await em.getConnection().execute(
          `insert into "${schema.name}".wallets (player_id, currency)
           values (?, ?)`,
          ['00000000-0000-4000-8000-000000000001', 'bad'],
          'all',
          em.getTransactionContext(),
        );
      }),
    ).rejects.toThrow();

    // Cria uma carteira versão 1 para testar a proteção ao reverter a versão.
    await schema.orm.em.getConnection().execute(
      `insert into "${schema.name}".wallets (id, player_id, currency, version)
       values (?, ?, 'BRL', 1)`,
      [
        '00000000-0000-4000-8000-000000000010',
        '00000000-0000-4000-8000-000000000011',
      ],
    );

    // Reverte novamente as migrations 010, 009, 008, 007 e 006.
    for (let index = 0; index < 5; index += 1) {
      await schema.migrateDown();
    }

    // Coloca a carteira de teste em versão zero para permitir a reversão da 003.
    await schema.orm.em.getConnection().execute(
      `update "${schema.name}".wallets set version = 0
       where id = '00000000-0000-4000-8000-000000000010'`,
    );

    // Reverte as migrations 005 e 004.
    await schema.migrateDown();
    await schema.migrateDown();

    // A migration 003 não pode ser revertida enquanto houver versão zero.
    await expect(schema.migrateDown()).rejects.toThrow(
      'Não é possível reverter enquanto houver wallets com versão zero',
    );

    const versionMigration = (await schema.orm.em.getConnection().execute(
      `select name from "${schema.name}".schema_migrations
       where name = '003-wallet-version-zero'`,
    )) as { name: string }[];

    expect(versionMigration).toHaveLength(1);

    // Remove as carteiras usadas nos testes de reversão.
    await schema.orm.em.getConnection().execute(
      `delete from "${schema.name}".wallets
       where id = '00000000-0000-4000-8000-000000000010'`,
    );
    await schema.orm.em.getConnection().execute(
      `delete from "${schema.name}".wallets
       where id = '00000000-0000-4000-8000-000000000014'`,
    );
    await schema.orm.em.getConnection().execute(
      `delete from "${schema.name}".wallets
       where id = '00000000-0000-4000-8000-000000000012'`,
    );

    // Reverte as três migrations restantes: 003, 002 e 001.
    for (let index = 0; index < 3; index += 1) {
      await schema.migrateDown();
    }

    // Apenas a tabela de controle das migrations deve permanecer.
    const remainingTables = (await schema.orm.em.getConnection().execute(
      `select table_name from information_schema.tables
       where table_schema = ? and table_type = 'BASE TABLE'`,
      [schema.name],
    )) as { table_name: string }[];

    expect(remainingTables.map(({ table_name }) => table_name)).toEqual([
      'schema_migrations',
    ]);
  }, 30_000);
});

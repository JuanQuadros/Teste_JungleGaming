import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '../../domain/money.js';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionType,
} from '../../domain/wager-transaction.js';
import { Wallet } from '../../domain/wallet.js';
import { mikroOrmConfig } from '../../mikro-orm.config.js';
import { MikroOrmWalletLedgerEntryRepository } from './repositories/mikro-orm-wallet-ledger-entry.repository.js';
import { MikroOrmWagerTransactionRepository } from './repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository.js';

describe('MikroORM persistence repositories (PostgreSQL)', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.connect();
    const result = await orm.em
      .getConnection()
      .execute('select name from schema_migrations');
    const migrations = result as { name: string }[];

    expect(migrations.map(({ name }) => name)).toContain(
      '003-wallet-version-zero',
    );
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  it('persiste, atualiza e reidrata wallet, transação e ledger sem perder precisão', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const transactionId = randomUUID();
    const ledgerEntryId = randomUUID();
    const entityManager = orm.em.fork();
    const walletRepository = new MikroOrmWalletRepository(entityManager);
    const transactionRepository = new MikroOrmWagerTransactionRepository(
      entityManager,
    );
    const ledgerRepository = new MikroOrmWalletLedgerEntryRepository(
      entityManager,
    );

    await entityManager.begin();
    try {
      const wallet = Wallet.open(walletId, playerId, 'BRL');
      walletRepository.insert(wallet);
      await entityManager.flush();
      entityManager.clear();

      const restoredWallet = await walletRepository.findById(walletId);
      expect(restoredWallet).not.toBeNull();
      expect(restoredWallet?.balance.toJSON()).toEqual({
        amount: '0.00',
        currency: 'BRL',
      });

      restoredWallet!.credit(Money.from({ amount: '123.45', currency: 'BRL' }));
      await walletRepository.update(restoredWallet!);
      await entityManager.flush();
      entityManager.clear();

      const creditedWallet = await walletRepository.findByPlayerAndCurrency(
        playerId,
        'BRL',
      );
      expect(creditedWallet?.balance.toJSON().amount).toBe('123.45');
      expect(creditedWallet?.version).toBe(1);

      const transaction = WagerTransaction.create({
        id: transactionId,
        providerId: 'integration-provider',
        externalTransactionId: `external-${transactionId}`,
        idempotencyKey: `idempotency-${transactionId}`,
        payloadHash: 'a'.repeat(64),
        walletId,
        playerId,
        roundId: 'integration-round',
        gameId: 'integration-game',
        kind: WagerTransactionType.BET,
        amount: Money.from({ amount: '23.45', currency: 'BRL' }),
        currency: 'BRL',
      });
      transaction.markProcessed();
      transactionRepository.insert(transaction);
      await entityManager.flush();

      const balanceBefore = creditedWallet!.balance;
      creditedWallet!.debit(transaction.amount);
      await walletRepository.update(creditedWallet!);
      ledgerRepository.insert(
        WalletLedgerEntry.createForTransaction({
          id: ledgerEntryId,
          transaction,
          balanceBefore,
        }),
      );
      await entityManager.flush();
      entityManager.clear();

      const restoredTransaction =
        await transactionRepository.findById(transactionId);
      expect(restoredTransaction?.toSnapshot()).toMatchObject({
        id: transactionId,
        status: 'PROCESSED',
        payloadHash: 'a'.repeat(64),
      });
      expect(restoredTransaction?.amount.toJSON()).toEqual({
        amount: '23.45',
        currency: 'BRL',
      });
      expect(
        (
          await transactionRepository.findByIdempotencyKey(
            `idempotency-${transactionId}`,
          )
        )?.id,
      ).toBe(transactionId);
      expect(
        (
          await transactionRepository.findByProviderAndExternalId(
            'integration-provider',
            `external-${transactionId}`,
          )
        )?.id,
      ).toBe(transactionId);

      const restoredEntry =
        await ledgerRepository.findByTransactionId(transactionId);
      expect(restoredEntry?.amount.toJSON()).toEqual({
        amount: '23.45',
        currency: 'BRL',
      });
      expect(restoredEntry?.balanceBefore.toJSON().amount).toBe('123.45');
      expect(restoredEntry?.balanceAfter.toJSON().amount).toBe('100.00');
      expect(
        await ledgerRepository.findReversalByTransactionId(transactionId),
      ).toBeNull();

      const finalWallet = await walletRepository.findById(walletId);
      expect(finalWallet?.balance.toJSON().amount).toBe('100.00');
      expect(finalWallet?.version).toBe(2);
    } finally {
      await entityManager.rollback();
      entityManager.clear();
    }
  });
});

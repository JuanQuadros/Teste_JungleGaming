import { Injectable } from '@nestjs/common';
import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import type {
  WalletTransactionContext,
  WalletTransactionUnitOfWorkPort,
} from '../../application/ports/persistence.repositories.js';
import { WalletEntity } from './entities/wallet.entity.js';
import {
  MikroOrmWalletLedgerEntryRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from './repositories/index.js';
import { PersistenceRecordNotFoundError } from './repositories/persistence-record-not-found.error.js';

/** Abre a transação e serializa por chave antes de bloquear a wallet. */
@Injectable()
export class MikroOrmWalletTransactionUnitOfWork implements WalletTransactionUnitOfWorkPort {
  constructor(private readonly entityManager: EntityManager) {}

  /** Locks transacionais evitam corrida entre instâncias e liberam no commit/rollback. */
  withIdempotencyAndWalletLock<T>(
    walletId: string,
    idempotencyKey: string,
    operation: (context: WalletTransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.entityManager.transactional(
      async (transactionalEntityManager) => {
        // A trava é por chave, portanto operações independentes não se bloqueiam entre si.
        await transactionalEntityManager
          .getConnection()
          .execute(
            'select pg_advisory_xact_lock(hashtextextended(?, 0))',
            [idempotencyKey],
            'all',
            transactionalEntityManager.getTransactionContext(),
          );

        const wallets = new MikroOrmWalletRepository(
          transactionalEntityManager,
        );
        const transactions = new MikroOrmWagerTransactionRepository(
          transactionalEntityManager,
        );
        const ledgerEntries = new MikroOrmWalletLedgerEntryRepository(
          transactionalEntityManager,
        );
        const existingIdempotentTransaction =
          await transactions.findByIdempotencyKey(idempotencyKey);

        // Replay ou conflito são resolvidos antes de buscar e bloquear a wallet.
        if (existingIdempotentTransaction) {
          return operation({
            wallet: null,
            wallets,
            transactions,
            ledgerEntries,
            existingIdempotentTransaction,
          });
        }

        await transactionalEntityManager.findOne(
          WalletEntity,
          { id: walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        const wallet = await wallets.findById(walletId);
        if (!wallet) {
          throw new PersistenceRecordNotFoundError('wallet', walletId);
        }

        return operation({
          wallet,
          wallets,
          transactions,
          ledgerEntries,
          existingIdempotentTransaction: null,
        });
      },
    );
  }
}

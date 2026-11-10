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

/** Abre uma transação SQL, bloqueia uma wallet e compartilha o mesmo EntityManager. */
@Injectable()
export class MikroOrmWalletTransactionUnitOfWork implements WalletTransactionUnitOfWorkPort {
  constructor(private readonly entityManager: EntityManager) {}

  /** O lock é liberado pelo PostgreSQL somente quando o callback confirma ou reverte. */
  withLockedWallet<T>(
    walletId: string,
    operation: (context: WalletTransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.entityManager.transactional(
      async (transactionalEntityManager) => {
        await transactionalEntityManager.findOne(
          WalletEntity,
          { id: walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        const wallets = new MikroOrmWalletRepository(
          transactionalEntityManager,
        );
        const wallet = await wallets.findById(walletId);
        if (!wallet) {
          throw new PersistenceRecordNotFoundError('wallet', walletId);
        }

        return operation({
          wallet,
          wallets,
          transactions: new MikroOrmWagerTransactionRepository(
            transactionalEntityManager,
          ),
          ledgerEntries: new MikroOrmWalletLedgerEntryRepository(
            transactionalEntityManager,
          ),
        });
      },
    );
  }
}

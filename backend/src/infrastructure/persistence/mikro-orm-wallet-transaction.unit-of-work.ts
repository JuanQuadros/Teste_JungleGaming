import { Injectable } from '@nestjs/common';
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import type {
  InboxMessage,
  WalletCreationUnitOfWorkPort,
  WalletTransactionContext,
  WalletTransactionUnitOfWorkPort,
} from '../../application/ports/persistence.repositories.js';
import { WalletAlreadyExistsError } from '../../application/wallet-management/wallet-already-exists.error.js';
import { WagerTransactionStatus } from '../../domain/wager-transaction.js';
import type { Wallet } from '../../domain/wallet.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import { WalletEntity } from './entities/wallet.entity.js';
import {
  MikroOrmWalletLedgerEntryRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
  MikroOrmOutboxEventRepository,
} from './repositories/index.js';
import { PersistenceRecordNotFoundError } from './repositories/persistence-record-not-found.error.js';
import { InboxMessageConflictError } from './inbox-message-conflict.error.js';

/** Abre a transação e serializa por chave antes de bloquear a wallet. */
@Injectable()
export class MikroOrmWalletTransactionUnitOfWork
  implements WalletTransactionUnitOfWorkPort, WalletCreationUnitOfWorkPort
{
  constructor(private readonly entityManager: EntityManager) {}

  async create(
    wallet: Wallet,
    openingTransaction: WagerTransaction | null,
    openingEntry: WalletLedgerEntry | null,
  ): Promise<void> {
    try {
      await this.entityManager.transactional(async (em) => {
        new MikroOrmWalletRepository(em).insert(wallet);
        await em.flush();
        if (openingTransaction) {
          new MikroOrmWagerTransactionRepository(em).insert(openingTransaction);
          await em.flush();
        }
        if (openingEntry) {
          new MikroOrmWalletLedgerEntryRepository(em).insert(openingEntry);
          await em.flush();
        }
      });
    } catch (error) {
      if (
        error instanceof UniqueConstraintViolationException &&
        (await this.entityManager.fork().findOne(WalletEntity, {
          playerId: wallet.playerId,
          currency: wallet.currency,
        }))
      ) {
        throw new WalletAlreadyExistsError();
      }
      throw error;
    }
  }

  /** Locks transacionais evitam corrida entre instâncias e liberam no commit/rollback. */
  withIdempotencyAndWalletLock<T>(
    walletId: string,
    idempotencyKey: string,
    operation: (context: WalletTransactionContext) => Promise<T>,
    inboxMessage?: InboxMessage,
  ): Promise<T> {
    return this.entityManager.transactional(
      async (transactionalEntityManager) => {
        const wallets = new MikroOrmWalletRepository(
          transactionalEntityManager,
        );
        const transactions = new MikroOrmWagerTransactionRepository(
          transactionalEntityManager,
        );
        const ledgerEntries = new MikroOrmWalletLedgerEntryRepository(
          transactionalEntityManager,
        );
        const outboxEvents = new MikroOrmOutboxEventRepository(
          transactionalEntityManager,
        );
        const inboxSchema = transactionalEntityManager.config.getSchema();
        const inboxTable = inboxSchema
          ? `"${inboxSchema.replaceAll('"', '""')}"."inbox_messages"`
          : 'inbox_messages';
        const complete = async (context: WalletTransactionContext) => {
          const result = await operation(context);
          if (inboxMessage) {
            await transactionalEntityManager.getConnection().execute(
              `update ${inboxTable}
               set processed_at = now()
               where consumer_name = ? and message_id = ?`,
              [inboxMessage.consumerName, inboxMessage.messageId],
              'all',
              transactionalEntityManager.getTransactionContext(),
            );
          }
          return result;
        };

        if (inboxMessage) {
          const inserted = await transactionalEntityManager
            .getConnection()
            .execute(
              `insert into ${inboxTable}
                (consumer_name, message_id, payload_hash)
               values (?, ?, ?)
               on conflict (consumer_name, message_id) do nothing
               returning payload_hash`,
              [
                inboxMessage.consumerName,
                inboxMessage.messageId,
                inboxMessage.payloadHash,
              ],
              'all',
              transactionalEntityManager.getTransactionContext(),
            );
          const insertedRows = inserted as unknown as {
            payload_hash: string;
          }[];
          if (insertedRows.length === 0) {
            const existing = await transactionalEntityManager
              .getConnection()
              .execute(
                `select payload_hash from ${inboxTable}
                 where consumer_name = ? and message_id = ?`,
                [inboxMessage.consumerName, inboxMessage.messageId],
                'all',
                transactionalEntityManager.getTransactionContext(),
              );
            const existingRows = existing as unknown as {
              payload_hash: string;
            }[];
            if (existingRows[0]?.payload_hash !== inboxMessage.payloadHash) {
              throw new InboxMessageConflictError();
            }
            return operation({
              wallet: null,
              wallets,
              transactions,
              ledgerEntries,
              outboxEvents,
              existingIdempotentTransaction: null,
              duplicateInboxMessage: true,
            });
          }
        }

        // A trava é por chave, portanto operações independentes não se bloqueiam entre si.
        await transactionalEntityManager
          .getConnection()
          .execute(
            'select pg_advisory_xact_lock(hashtextextended(?, 0))',
            [idempotencyKey],
            'all',
            transactionalEntityManager.getTransactionContext(),
          );

        const existingIdempotentTransaction =
          await transactions.findByIdempotencyKey(idempotencyKey);

        // Replay ou conflito são resolvidos antes de buscar e bloquear a wallet.
        if (existingIdempotentTransaction) {
          return complete({
            wallet: null,
            wallets,
            transactions,
            ledgerEntries,
            outboxEvents,
            existingIdempotentTransaction,
            duplicateInboxMessage: false,
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

        return complete({
          wallet,
          wallets,
          transactions,
          ledgerEntries,
          outboxEvents,
          existingIdempotentTransaction: null,
          duplicateInboxMessage: false,
        });
      },
    );
  }

  withPendingReferenceLock<T>(
    idempotencyKey: string,
    operation: (context: WalletTransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.entityManager.transactional(
      async (transactionalEntityManager) => {
        await this.acquireIdempotencyLock(
          transactionalEntityManager,
          idempotencyKey,
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
        const outboxEvents = new MikroOrmOutboxEventRepository(
          transactionalEntityManager,
        );
        const existingIdempotentTransaction =
          await transactions.findByIdempotencyKey(idempotencyKey);

        if (
          !existingIdempotentTransaction ||
          existingIdempotentTransaction.status !==
            WagerTransactionStatus.PENDING_REFERENCE
        ) {
          return operation({
            wallet: null,
            wallets,
            transactions,
            ledgerEntries,
            outboxEvents,
            existingIdempotentTransaction,
            duplicateInboxMessage: false,
          });
        }

        await transactionalEntityManager.findOne(
          WalletEntity,
          { id: existingIdempotentTransaction.walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        const wallet = await wallets.findById(
          existingIdempotentTransaction.walletId,
        );
        if (!wallet) {
          throw new PersistenceRecordNotFoundError(
            'wallet',
            existingIdempotentTransaction.walletId,
          );
        }

        return operation({
          wallet,
          wallets,
          transactions,
          ledgerEntries,
          outboxEvents,
          existingIdempotentTransaction,
          duplicateInboxMessage: false,
        });
      },
    );
  }

  private acquireIdempotencyLock(
    entityManager: EntityManager,
    idempotencyKey: string,
  ): Promise<unknown> {
    return entityManager
      .getConnection()
      .execute(
        'select pg_advisory_xact_lock(hashtextextended(?, 0))',
        [idempotencyKey],
        'all',
        entityManager.getTransactionContext(),
      );
  }
}

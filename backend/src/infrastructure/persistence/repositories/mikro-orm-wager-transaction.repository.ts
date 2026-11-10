import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../../domain/money.js';
import {
  WagerTransaction,
  type WagerTransactionSnapshot,
  type WagerTransactionType,
  type WagerTransactionStatus,
  type WagerFailureCode,
} from '../../../domain/wager-transaction.js';
import type { WagerTransactionRepositoryPort } from '../../../application/ports/persistence.repositories.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';
import { PersistenceRecordNotFoundError } from './persistence-record-not-found.error.js';

/** Adapta o aggregate da aposta ao seu registro transacional no PostgreSQL. */
@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(private readonly entityManager: EntityManager) {}

  /** Busca pela chave primária. */
  async findById(id: string): Promise<WagerTransaction | null> {
    const entity = await this.entityManager.findOne(WagerTransactionEntity, {
      id,
    });
    return entity ? this.toDomain(entity) : null;
  }

  /** Busca a requisição original para resolver replays de idempotência. */
  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const entity = await this.entityManager.findOne(WagerTransactionEntity, {
      idempotencyKey: key,
    });
    return entity ? this.toDomain(entity) : null;
  }

  /** Busca a operação externa única dentro do escopo do provedor. */
  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.entityManager.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });
    return entity ? this.toDomain(entity) : null;
  }

  /** Agenda uma transação nova no Unit of Work atual sem confirmar o flush. */
  insert(transaction: WagerTransaction): void {
    const entity = new WagerTransactionEntity();
    Object.assign(entity, this.toData(transaction));
    this.entityManager.persist(entity);
  }

  /** Atualiza estado e código de falha sem confirmar a transação SQL. */
  async update(transaction: WagerTransaction): Promise<void> {
    const entity = await this.entityManager.findOne(WagerTransactionEntity, {
      id: transaction.id,
    });
    if (!entity) {
      throw new PersistenceRecordNotFoundError(
        'wager_transaction',
        transaction.id,
      );
    }

    Object.assign(entity, this.toData(transaction));
  }

  /** Reidrata o estado salvo sem executar a sequência histórica de transições. */
  private toDomain(entity: WagerTransactionEntity): WagerTransaction {
    const snapshot: WagerTransactionSnapshot = {
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash.trimEnd(),
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind as WagerTransactionType,
      amount: Money.from({ amount: entity.amount, currency: entity.currency }),
      currency: entity.currency,
      referenceExternalTransactionId: entity.referenceExternalTransactionId,
      referenceTransactionId: entity.referenceTransactionId,
      status: entity.status as WagerTransactionStatus,
      failureCode: entity.failureCode as WagerFailureCode | null,
    };
    return WagerTransaction.rehydrate(snapshot);
  }

  /** Converte o snapshot de domínio em campos escalares persistidos. */
  private toData(
    transaction: WagerTransaction,
  ): Partial<WagerTransactionEntity> {
    const snapshot = transaction.toSnapshot();
    return {
      id: snapshot.id,
      providerId: snapshot.providerId,
      externalTransactionId: snapshot.externalTransactionId,
      idempotencyKey: snapshot.idempotencyKey,
      payloadHash: snapshot.payloadHash,
      walletId: snapshot.walletId,
      playerId: snapshot.playerId,
      roundId: snapshot.roundId,
      gameId: snapshot.gameId,
      kind: snapshot.kind,
      amount: snapshot.amount.toJSON().amount,
      currency: snapshot.currency,
      status: snapshot.status,
      referenceExternalTransactionId: snapshot.referenceExternalTransactionId,
      referenceTransactionId: snapshot.referenceTransactionId,
      failureCode: snapshot.failureCode,
    };
  }
}

import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../../domain/money.js';
import { Wallet } from '../../../domain/wallet.js';
import type { WalletRepositoryPort } from '../../../application/ports/persistence.repositories.js';
import { WalletEntity } from '../entities/wallet.entity.js';
import { PersistenceRecordNotFoundError } from './persistence-record-not-found.error.js';

/** Adapta a wallet de domínio à tabela wallets sem expor MikroORM ao domínio. */
@Injectable()
export class MikroOrmWalletRepository implements WalletRepositoryPort {
  constructor(private readonly entityManager: EntityManager) {}

  /** Busca por identificador e reidrata os invariantes do domínio. */
  async findById(id: string): Promise<Wallet | null> {
    const entity = await this.entityManager.findOne(WalletEntity, { id });
    return entity ? this.toDomain(entity) : null;
  }

  /** Busca pela chave de negócio única de jogador e moeda. */
  async findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null> {
    const entity = await this.entityManager.findOne(WalletEntity, {
      playerId,
      currency,
    });
    return entity ? this.toDomain(entity) : null;
  }

  /** Agenda uma wallet nova no Unit of Work atual; o chamador controla o flush. */
  insert(wallet: Wallet): void {
    const entity = new WalletEntity();
    Object.assign(entity, this.toData(wallet));
    this.entityManager.persist(entity);
  }

  /** Atualiza uma wallet carregada no Unit of Work sem confirmar a transação. */
  async update(wallet: Wallet): Promise<void> {
    const entity = await this.entityManager.findOne(WalletEntity, {
      id: wallet.id,
    });
    if (!entity) {
      throw new PersistenceRecordNotFoundError('wallet', wallet.id);
    }

    entity.playerId = wallet.playerId;
    entity.currency = wallet.currency;
    entity.balance = wallet.balance.toJSON().amount;
    entity.version = wallet.version;
    entity.updatedAt = new Date();
  }

  /** Converte a linha SQL para o aggregate e deixa suas invariantes revalidadas. */
  private toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.from({
        amount: entity.balance,
        currency: entity.currency,
      }),
      version: entity.version,
    });
  }

  /** Converte o aggregate para os tipos simples aceitos pela entidade ORM. */
  private toData(wallet: Wallet): Partial<WalletEntity> {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
    };
  }
}

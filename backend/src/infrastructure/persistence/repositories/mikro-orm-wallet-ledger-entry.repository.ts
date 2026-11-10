import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../../domain/money.js';
import {
  WalletLedgerDirection,
  WalletLedgerEntry,
} from '../../../domain/wallet-ledger-entry.js';
import type { WalletLedgerEntryRepositoryPort } from '../../../application/ports/persistence.repositories.js';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';

/** Persiste e consulta lançamentos sem expor métodos de alteração ou remoção. */
@Injectable()
export class MikroOrmWalletLedgerEntryRepository implements WalletLedgerEntryRepositoryPort {
  constructor(private readonly entityManager: EntityManager) {}

  /** Busca o lançamento único vinculado à transação financeira. */
  async findByTransactionId(
    transactionId: string,
  ): Promise<WalletLedgerEntry | null> {
    const entity = await this.entityManager.findOne(WalletLedgerEntryEntity, {
      transactionId,
    });
    return entity ? this.toDomain(entity) : null;
  }

  /** Verifica se uma operação original já foi revertida. */
  async findReversalByTransactionId(
    originalTransactionId: string,
  ): Promise<WalletLedgerEntry | null> {
    const entity = await this.entityManager.findOne(WalletLedgerEntryEntity, {
      reversalOfTransactionId: originalTransactionId,
    });
    return entity ? this.toDomain(entity) : null;
  }

  /** Agenda somente uma inclusão; alterações e exclusões não fazem parte do contrato. */
  insert(entry: WalletLedgerEntry): void {
    const entity = new WalletLedgerEntryEntity();
    Object.assign(entity, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.amount.toJSON().amount,
      currency: entry.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      reversalOfTransactionId: entry.reversalOfTransactionId,
    });
    this.entityManager.persist(entity);
  }

  /** Recria e valida a aritmética do lançamento ao lê-lo do banco. */
  private toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
    return WalletLedgerEntry.create({
      id: entity.id,
      walletId: entity.walletId,
      transactionId: entity.transactionId,
      direction: entity.direction as WalletLedgerDirection,
      amount: Money.from({ amount: entity.amount, currency: entity.currency }),
      currency: entity.currency,
      balanceBefore: Money.from({
        amount: entity.balanceBefore,
        currency: entity.currency,
      }),
      balanceAfter: Money.from({
        amount: entity.balanceAfter,
        currency: entity.currency,
      }),
      reversalOfTransactionId: entity.reversalOfTransactionId,
    });
  }
}

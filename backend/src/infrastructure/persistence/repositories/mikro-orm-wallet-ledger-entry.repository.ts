import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../../domain/money.js';
import {
  WalletLedgerDirection,
  WalletLedgerEntry,
} from '../../../domain/wallet-ledger-entry.js';
import type {
  WalletLedgerEntryRepositoryPort,
  WalletLedgerReconciliationSnapshot,
} from '../../../application/ports/persistence.repositories.js';
import type {
  WalletLedgerCursor,
  WalletLedgerPageItem,
} from '../../../application/ports/persistence.repositories.js';
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

  async findPageByWallet(
    walletId: string,
    cursor: WalletLedgerCursor | null,
    limit: number,
  ): Promise<{ items: WalletLedgerPageItem[]; hasMore: boolean }> {
    const cursorClause = cursor
      ? "and (date_trunc('milliseconds', created_at), id) < (?::timestamptz, ?::uuid)"
      : '';
    const parameters = cursor
      ? [walletId, cursor.createdAt, cursor.id, limit + 1]
      : [walletId, limit + 1];
    const schema = this.entityManager.config.getSchema() ?? 'public';
    const ledgerTable = `"${schema.replaceAll('"', '""')}".wallet_ledger_entries`;
    const result = await this.entityManager.getConnection().execute(
      `select
        id,
        wallet_id as "walletId",
        transaction_id as "transactionId",
        direction,
        amount::text as amount,
        currency,
        balance_before::text as "balanceBefore",
        balance_after::text as "balanceAfter",
        reversal_of_transaction_id as "reversalOfTransactionId",
        to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
        to_char(date_trunc('milliseconds', created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "cursorAt"
      from ${ledgerTable}
      where wallet_id = ? ${cursorClause}
      order by date_trunc('milliseconds', created_at) desc, id desc
      limit ?`,
      parameters,
    );
    const rows = result as Array<
      Pick<
        WalletLedgerEntryEntity,
        | 'id'
        | 'walletId'
        | 'transactionId'
        | 'direction'
        | 'amount'
        | 'currency'
        | 'balanceBefore'
        | 'balanceAfter'
        | 'reversalOfTransactionId'
      > & { createdAt: string; cursorAt: string }
    >;
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit).map((row) => ({
        entry: WalletLedgerEntry.rehydrate({
          id: row.id,
          walletId: row.walletId,
          transactionId: row.transactionId,
          direction: row.direction as WalletLedgerDirection,
          amount: Money.from({ amount: row.amount, currency: row.currency }),
          currency: row.currency,
          balanceBefore: Money.from({
            amount: row.balanceBefore,
            currency: row.currency,
          }),
          balanceAfter: Money.from({
            amount: row.balanceAfter,
            currency: row.currency,
          }),
          reversalOfTransactionId: row.reversalOfTransactionId,
          createdAt: new Date(row.createdAt),
        }),
        createdAt: row.createdAt,
        cursorAt: row.cursorAt,
      })),
      hasMore,
    };
  }

  async reconcileWallet(
    walletId: string,
  ): Promise<WalletLedgerReconciliationSnapshot | null> {
    const schema = this.entityManager.config.getSchema() ?? 'public';
    const safeSchema = `"${schema.replaceAll('"', '""')}"`;
    const result = await this.entityManager.getConnection().execute(
      `select
        w.currency as currency,
        w.balance::text as "walletBalance",
        coalesce(sum(case
            when l.currency = w.currency and l.direction = 'CREDIT' then l.amount
            when l.currency = w.currency and l.direction = 'DEBIT' then -l.amount
            else 0
          end), 0)::text as "ledgerBalance",
        count(l.id)::text as "entryCount",
        count(l.id) filter (
          where l.currency is not null and l.currency <> w.currency
        )::text as "currencyMismatchCount"
      from ${safeSchema}.wallets w
      left join ${safeSchema}.wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ?
      group by w.id, w.currency, w.balance`,
      [walletId],
    );
    const rows = result as Array<{
      currency: string;
      walletBalance: string;
      ledgerBalance: string;
      entryCount: string;
      currencyMismatchCount: string;
    }>;
    const row = rows[0];
    if (!row) return null;

    return {
      currency: row.currency,
      walletBalance: Money.from({
        amount: row.walletBalance,
        currency: row.currency,
      }),
      ledgerBalance: Money.from({
        amount: row.ledgerBalance,
        currency: row.currency,
      }),
      entryCount: this.parseCount(row.entryCount),
      currencyMismatchCount: this.parseCount(row.currencyMismatchCount),
    };
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

  private parseCount(value: string): number {
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('A contagem de lançamentos excede o limite suportado.');
    }
    return count;
  }
}

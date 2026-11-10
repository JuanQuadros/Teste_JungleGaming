import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

/** Representação MikroORM do lançamento imutável e de sua referência de reversão. */
@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({
  name: 'wallet_ledger_entries_transaction_id_key',
  properties: ['transactionId'],
})
@Unique({
  name: 'wallet_ledger_entries_transaction_wallet_unique',
  properties: ['transactionId', 'walletId'],
})
@Unique({
  name: 'wallet_ledger_entries_reversal_once_unique',
  properties: ['reversalOfTransactionId'],
})
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'wallet_id' })
  walletId!: string;

  @Property({ type: 'uuid', fieldName: 'transaction_id' })
  transactionId!: string;

  @Property({ type: 'string', length: 6 })
  direction!: string;

  // NUMERIC continua como string para preservar o valor decimal exato.
  @Property({ type: 'numeric', columnType: 'numeric(20, 2)' })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({
    type: 'numeric',
    fieldName: 'balance_before',
    columnType: 'numeric(20, 2)',
  })
  balanceBefore!: string;

  @Property({
    type: 'numeric',
    fieldName: 'balance_after',
    columnType: 'numeric(20, 2)',
  })
  balanceAfter!: string;

  @Property({
    type: 'timestamptz',
    fieldName: 'created_at',
    defaultRaw: 'now()',
  })
  createdAt!: Date;

  // A migration mantém a chave estrangeira composta que vincula a mesma wallet.
  @Property({
    type: 'uuid',
    fieldName: 'reversal_of_transaction_id',
    nullable: true,
  })
  reversalOfTransactionId: string | null = null;
}

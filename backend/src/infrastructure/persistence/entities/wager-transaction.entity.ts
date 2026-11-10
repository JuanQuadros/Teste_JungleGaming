import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

/** Representação MikroORM da operação e de seu resultado persistido. */
@Entity({ tableName: 'wager_transactions' })
@Unique({
  name: 'wager_transactions_idempotency_key_key',
  properties: ['idempotencyKey'],
})
@Unique({
  name: 'wager_transactions_provider_id_external_transaction_id_key',
  properties: ['providerId', 'externalTransactionId'],
})
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'text', fieldName: 'provider_id' })
  providerId!: string;

  @Property({ type: 'text', fieldName: 'external_transaction_id' })
  externalTransactionId!: string;

  @Property({ type: 'text', fieldName: 'idempotency_key' })
  idempotencyKey!: string;

  @Property({
    type: 'string',
    fieldName: 'payload_hash',
    columnType: 'char(64)',
  })
  payloadHash!: string;

  // IDs escalares deixam a navegação entre aggregates sob controle dos repositórios.
  @Property({ type: 'uuid', fieldName: 'wallet_id' })
  walletId!: string;

  @Property({ type: 'uuid', fieldName: 'player_id' })
  playerId!: string;

  @Property({ type: 'text', fieldName: 'round_id' })
  roundId!: string;

  @Property({ type: 'text', fieldName: 'game_id' })
  gameId!: string;

  @Property({ type: 'string', length: 12 })
  kind!: string;

  // Valores monetários permanecem decimais em texto na fronteira com o PostgreSQL.
  @Property({ type: 'numeric', columnType: 'numeric(20, 2)' })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'string', length: 20 })
  status!: string;

  @Property({
    type: 'numeric',
    fieldName: 'response_balance',
    columnType: 'numeric(20, 2)',
    nullable: true,
  })
  responseBalance: string | null = null;

  @Property({
    type: 'text',
    fieldName: 'reference_external_transaction_id',
    nullable: true,
  })
  referenceExternalTransactionId: string | null = null;

  @Property({
    type: 'uuid',
    fieldName: 'reference_transaction_id',
    nullable: true,
  })
  referenceTransactionId: string | null = null;

  @Property({
    type: 'string',
    length: 64,
    fieldName: 'failure_code',
    nullable: true,
  })
  failureCode: string | null = null;

  @Property({
    type: 'timestamptz',
    fieldName: 'created_at',
    defaultRaw: 'now()',
  })
  createdAt!: Date;

  @Property({ type: 'timestamptz', fieldName: 'processed_at', nullable: true })
  processedAt: Date | null = null;

  @Property({
    type: 'integer',
    fieldName: 'reference_attempts',
    default: 0,
  })
  referenceAttempts = 0;

  @Property({
    type: 'timestamptz',
    fieldName: 'reference_next_attempt_at',
    nullable: true,
  })
  referenceNextAttemptAt: Date | null = null;
}

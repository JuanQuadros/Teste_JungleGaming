import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

/** Representação MikroORM da linha de saldo armazenada na tabela wallets. */
@Entity({ tableName: 'wallets' })
@Unique({
  name: 'wallets_player_id_currency_key',
  properties: ['playerId', 'currency'],
})
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'player_id' })
  playerId!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  // NUMERIC é mantido como string para não converter saldo para ponto flutuante.
  @Property({ type: 'numeric', columnType: 'numeric(20, 2)', default: '0.00' })
  balance!: string;

  @Property({ type: 'integer', default: 0 })
  version!: number;

  @Property({
    type: 'timestamptz',
    fieldName: 'created_at',
    defaultRaw: 'now()',
  })
  createdAt!: Date;

  @Property({
    type: 'timestamptz',
    fieldName: 'updated_at',
    defaultRaw: 'now()',
    onUpdate: () => new Date(),
  })
  updatedAt!: Date;
}

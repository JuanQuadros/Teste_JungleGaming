import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** Linha de deduplicação persistente usada pelo consumidor SQS. */
@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'text', fieldName: 'consumer_name' })
  consumerName!: string;

  @PrimaryKey({ type: 'text', fieldName: 'message_id' })
  messageId!: string;

  @Property({
    type: 'string',
    fieldName: 'payload_hash',
    columnType: 'char(64)',
  })
  payloadHash!: string;

  @Property({
    type: 'timestamptz',
    fieldName: 'received_at',
    defaultRaw: 'now()',
  })
  receivedAt!: Date;

  @Property({ type: 'timestamptz', fieldName: 'processed_at', nullable: true })
  processedAt: Date | null = null;
}

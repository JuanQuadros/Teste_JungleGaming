import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** Evento de integração armazenado para publicação após o commit financeiro. */
@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'aggregate_id' })
  aggregateId!: string;

  @Property({ type: 'text', fieldName: 'event_type' })
  eventType!: string;

  @Property({ type: 'json', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ type: 'timestamptz', fieldName: 'occurred_at' })
  occurredAt!: Date;

  @Property({ type: 'integer', default: 0 })
  attempts!: number;

  @Property({
    type: 'timestamptz',
    fieldName: 'next_attempt_at',
    nullable: true,
  })
  nextAttemptAt: Date | null = null;

  @Property({ type: 'timestamptz', fieldName: 'published_at', nullable: true })
  publishedAt: Date | null = null;
}

import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type {
  OutboxEvent,
  OutboxEventRepositoryPort,
  PendingOutboxEvent,
} from '../../../application/ports/persistence.repositories.js';
import { OutboxMessageEntity } from '../entities/outbox-message.entity.js';

@Injectable()
export class MikroOrmOutboxEventRepository implements OutboxEventRepositoryPort {
  constructor(private readonly entityManager: EntityManager) {}

  insert(event: OutboxEvent): void {
    const entity = new OutboxMessageEntity();
    Object.assign(entity, {
      id: event.id,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      correlationId: event.correlationId,
      causationId: event.causationId,
      version: event.version,
      payload: event.payload,
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: null,
      publishedAt: null,
    });
    this.entityManager.persist(entity);
  }

  claimDue(
    now: Date,
    leaseUntil: Date,
    limit: number,
  ): Promise<PendingOutboxEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Outbox claim limit must be between 1 and 100.');
    }

    return this.entityManager.transactional(async (em) => {
      const schema = em.config.getSchema();
      const table = schema
        ? `"${schema.replaceAll('"', '""')}"."outbox_messages"`
        : 'outbox_messages';
      const result = await em.getConnection().execute(
        `with due_events as (
          select candidate.id
          from ${table} as candidate
          where candidate.published_at is null
            and (candidate.next_attempt_at is null or candidate.next_attempt_at <= ?)
            and not exists (
              select 1
              from ${table} as earlier
              where earlier.aggregate_id = candidate.aggregate_id
                and earlier.published_at is null
                and (earlier.occurred_at, earlier.id) <
                    (candidate.occurred_at, candidate.id)
            )
          order by candidate.occurred_at asc, candidate.id asc
          limit ?
          for update of candidate skip locked
        )
        update ${table} as event
        set attempts = event.attempts + 1,
            next_attempt_at = ?
        from due_events
        where event.id = due_events.id
        returning event.id, event.aggregate_id, event.event_type,
                  event.correlation_id, event.causation_id, event.event_version,
                  event.payload, event.occurred_at, event.attempts`,
        [now, limit, leaseUntil],
        'all',
        em.getTransactionContext(),
      );
      const rows = result as unknown as Array<{
        id: string;
        aggregate_id: string;
        event_type: string;
        correlation_id: string;
        causation_id: string | null;
        event_version: number;
        payload: Record<string, unknown>;
        occurred_at: Date | string;
        attempts: number;
      }>;
      return rows.map((row) => ({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        version: row.event_version,
        payload: row.payload,
        occurredAt: new Date(row.occurred_at),
        attempts: row.attempts,
      }));
    });
  }

  markPublished(
    id: string,
    attempts: number,
    publishedAt: Date,
  ): Promise<boolean> {
    return this.updateClaimedEvent(
      `update outbox_messages
       set published_at = ?, next_attempt_at = null
       where id = ? and attempts = ? and published_at is null
       returning id`,
      [publishedAt, id, attempts],
    );
  }

  scheduleRetry(
    id: string,
    attempts: number,
    nextAttemptAt: Date,
  ): Promise<boolean> {
    return this.updateClaimedEvent(
      `update outbox_messages
       set next_attempt_at = ?
       where id = ? and attempts = ? and published_at is null
       returning id`,
      [nextAttemptAt, id, attempts],
    );
  }

  private updateClaimedEvent(
    sql: string,
    parameters: unknown[],
  ): Promise<boolean> {
    return this.entityManager.transactional(async (em) => {
      const schema = em.config.getSchema();
      const table = schema
        ? `"${schema.replaceAll('"', '""')}"."outbox_messages"`
        : 'outbox_messages';
      const statement = sql.replaceAll('outbox_messages', table);
      const result = await em
        .getConnection()
        .execute(statement, parameters, 'all', em.getTransactionContext());
      return (result as unknown[]).length > 0;
    });
  }
}

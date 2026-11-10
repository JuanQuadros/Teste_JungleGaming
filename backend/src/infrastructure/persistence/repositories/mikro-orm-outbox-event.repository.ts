import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type {
  OutboxEvent,
  OutboxEventRepositoryPort,
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
      payload: event.payload,
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: null,
      publishedAt: null,
    });
    this.entityManager.persist(entity);
  }
}

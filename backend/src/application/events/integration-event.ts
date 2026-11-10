import type { OutboxEvent } from '../ports/persistence.repositories.js';

export interface IntegrationEventInput {
  id: string;
  aggregateId: string;
  correlationId: string;
  causationId: string | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

abstract class VersionedIntegrationEvent implements OutboxEvent {
  abstract readonly eventType: string;
  readonly version = 1;

  constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly correlationId: string,
    readonly causationId: string | null,
    readonly payload: Record<string, unknown>,
    readonly occurredAt: Date,
  ) {}
}

export class WagerTransactionProcessed extends VersionedIntegrationEvent {
  readonly eventType = 'WagerTransactionProcessed';
}

export class WagerTransactionRejected extends VersionedIntegrationEvent {
  readonly eventType = 'WagerTransactionRejected';
}

export class WagerTransactionPendingReference extends VersionedIntegrationEvent {
  readonly eventType = 'WagerTransactionPendingReference';
}

export class WagerTransactionReferenceExpired extends VersionedIntegrationEvent {
  readonly eventType = 'WagerTransactionReferenceExpired';
}

export class WalletBalanceChanged extends VersionedIntegrationEvent {
  readonly eventType = 'WalletBalanceChanged';
}

export type IntegrationEventType =
  | 'WagerTransactionProcessed'
  | 'WagerTransactionRejected'
  | 'WagerTransactionPendingReference'
  | 'WagerTransactionReferenceExpired'
  | 'WalletBalanceChanged';

export function createIntegrationEvent(
  eventType: IntegrationEventType,
  input: IntegrationEventInput,
): OutboxEvent {
  const { id, aggregateId, correlationId, causationId, payload, occurredAt } =
    input;
  switch (eventType) {
    case 'WagerTransactionProcessed':
      return new WagerTransactionProcessed(
        id,
        aggregateId,
        correlationId,
        causationId,
        payload,
        occurredAt,
      );
    case 'WagerTransactionRejected':
      return new WagerTransactionRejected(
        id,
        aggregateId,
        correlationId,
        causationId,
        payload,
        occurredAt,
      );
    case 'WagerTransactionPendingReference':
      return new WagerTransactionPendingReference(
        id,
        aggregateId,
        correlationId,
        causationId,
        payload,
        occurredAt,
      );
    case 'WagerTransactionReferenceExpired':
      return new WagerTransactionReferenceExpired(
        id,
        aggregateId,
        correlationId,
        causationId,
        payload,
        occurredAt,
      );
    case 'WalletBalanceChanged':
      return new WalletBalanceChanged(
        id,
        aggregateId,
        correlationId,
        causationId,
        payload,
        occurredAt,
      );
  }
}

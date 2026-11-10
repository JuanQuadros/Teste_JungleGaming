
import { randomUUID } from 'node:crypto';
import type { MoneyProps } from '../../domain/money.js';
import {
  WalletLedgerDirection,
  type WalletLedgerEntry,
} from '../../domain/wallet-ledger-entry.js';
import type { Wallet } from '../../domain/wallet.js';
import type { OutboxEvent } from '../ports/persistence.repositories.js';

/** Propriedades comuns a todos os eventos de integração. */
export interface IntegrationEventProps<T extends object> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** Contexto utilizado para correlacionar eventos de uma operação. */
export interface EventContext {
  correlationId: string;
  causationId?: string;
  eventId?: string;
  occurredAt?: Date;
}

/** Estrutura pública serializada do evento. */
export interface IntegrationEventJSON<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/**
 * Classe abstrata que define o contrato dos eventos de integração.
 * Os aliases id e payload preservam a compatibilidade com a Outbox atual.
 */
export abstract class IntegrationEvent<T extends object>
  implements OutboxEvent
{
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    if (
      typeof props.eventId !== 'string' ||
      props.eventId.trim().length === 0 ||
      typeof props.aggregateId !== 'string' ||
      props.aggregateId.trim().length === 0 ||
      typeof props.correlationId !== 'string' ||
      props.correlationId.trim().length === 0 ||
      !(props.occurredAt instanceof Date) ||
      Number.isNaN(props.occurredAt.getTime()) ||
      !props.data ||
      typeof props.data !== 'object' ||
      Array.isArray(props.data)
    ) {
      throw new Error('Os dados obrigatórios do evento são inválidos.');
    }

    if (
      props.causationId !== undefined &&
      (typeof props.causationId !== 'string' ||
        props.causationId.trim().length === 0)
    ) {
      throw new Error('O causationId informado é inválido.');
    }

    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId ?? null;
    this.occurredAt = new Date(props.occurredAt);
    this.data = Object.freeze({ ...props.data });
  }

  /** Alias para compatibilidade com o identificador da Outbox. */
  get id(): string {
    return this.eventId;
  }

  /** Alias para compatibilidade com o payload da Outbox. */
  get payload(): Record<string, unknown> {
    return this.data as Record<string, unknown>;
  }

  /** Serializa o evento no formato definido pelo contrato. */
  toJSON(): IntegrationEventJSON<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId
        ? { causationId: this.causationId }
        : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}

/** Evento emitido quando uma transação é processada. */
export class WagerTransactionProcessed extends IntegrationEvent<
  Record<string, unknown>
> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  constructor(props: IntegrationEventProps<Record<string, unknown>>) {
    super(props);
  }
}

/** Evento emitido quando uma transação é rejeitada. */
export class WagerTransactionRejected extends IntegrationEvent<
  Record<string, unknown>
> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  constructor(props: IntegrationEventProps<Record<string, unknown>>) {
    super(props);
  }
}

/** Evento emitido quando uma transação aguarda sua referência. */
export class WagerTransactionPendingReference extends IntegrationEvent<
  Record<string, unknown>
> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  constructor(props: IntegrationEventProps<Record<string, unknown>>) {
    super(props);
  }
}

/** Evento adicional emitido quando uma referência pendente expira. */
export class WagerTransactionReferenceExpired extends IntegrationEvent<
  Record<string, unknown>
> {
  readonly eventType = 'WagerTransactionReferenceExpired';
  readonly version = 1;

  constructor(props: IntegrationEventProps<Record<string, unknown>>) {
    super(props);
  }
}

/** Dados financeiros serializáveis de uma alteração de saldo. */
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: WalletLedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Evento emitido somente quando o saldo da wallet realmente muda. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  /** Cria o evento a partir da wallet e do lançamento financeiro. */
  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: EventContext,
  ): WalletBalanceChanged {
    if (
      entry.walletId !== wallet.id ||
      entry.currency !== wallet.currency ||
      !entry.balanceAfter.equals(wallet.balance)
    ) {
      throw new Error(
        'O lançamento deve corresponder ao estado atual da wallet.',
      );
    }

    return new WalletBalanceChanged({
      eventId: context.eventId ?? randomUUID(),
      aggregateId: wallet.id,
      correlationId: context.correlationId,
      causationId: context.causationId ?? entry.transactionId,
      occurredAt: context.occurredAt ?? new Date(),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.amount.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

/** Tipos de eventos reconhecidos pela aplicação. */
export type IntegrationEventType =
  | 'WagerTransactionProcessed'
  | 'WagerTransactionRejected'
  | 'WagerTransactionPendingReference'
  | 'WagerTransactionReferenceExpired'
  | 'WalletBalanceChanged';

/** Entrada utilizada pela factory dos eventos sem factory própria. */
export interface IntegrationEventInput {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  data: Record<string, unknown>;
  occurredAt: Date;
}

/** Cria a classe concreta correspondente ao tipo de evento informado. */
export function createIntegrationEvent(
  eventType: Exclude<IntegrationEventType, 'WalletBalanceChanged'>,
  input: IntegrationEventInput,
): OutboxEvent {
  switch (eventType) {
    case 'WagerTransactionProcessed':
      return new WagerTransactionProcessed(input);

    case 'WagerTransactionRejected':
      return new WagerTransactionRejected(input);

    case 'WagerTransactionPendingReference':
      return new WagerTransactionPendingReference(input);

    case 'WagerTransactionReferenceExpired':
      return new WagerTransactionReferenceExpired(input);
  }
}

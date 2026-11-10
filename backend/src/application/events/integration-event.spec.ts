
import { describe, expect, it } from 'vitest';
import {
  createIntegrationEvent,
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionReferenceExpired,
  WagerTransactionRejected,
  type IntegrationEventProps,
} from './integration-event.js';
import {
  WalletLedgerDirection,
  type WalletLedgerEntry,
} from '../../domain/wallet-ledger-entry.js';
import type { Money } from '../../domain/money.js';
import type { Wallet } from '../../domain/wallet.js';

const occurredAt = new Date('2026-11-10T10:30:00.000Z');

const baseEventProps: IntegrationEventProps<Record<string, unknown>> = {
  eventId: 'event-123',
  aggregateId: 'aggregate-456',
  correlationId: 'correlation-789',
  causationId: 'causation-321',
  occurredAt,
  data: {
    transactionId: 'transaction-123',
    amount: '100.00',
    currency: 'BRL',
  },
};

describe('IntegrationEvent', () => {
  describe('WagerTransactionProcessed', () => {
    it('deve criar um evento com os campos obrigatórios', () => {
      const event = new WagerTransactionProcessed(baseEventProps);

      expect(event.eventId).toBe('event-123');
      expect(event.aggregateId).toBe('aggregate-456');
      expect(event.correlationId).toBe('correlation-789');
      expect(event.causationId).toBe('causation-321');
      expect(event.eventType).toBe('WagerTransactionProcessed');
      expect(event.version).toBe(1);
      expect(event.data.transactionId).toBe('transaction-123');
    });

    it('deve manter compatibilidade com os aliases da Outbox', () => {
      const event = new WagerTransactionProcessed(baseEventProps);

      expect(event.id).toBe(event.eventId);
      expect(event.payload).toEqual(event.data);
    });

    it('deve serializar o envelope no formato JSON esperado', () => {
      const event = new WagerTransactionProcessed(baseEventProps);

      expect(event.toJSON()).toEqual({
        eventId: 'event-123',
        eventType: 'WagerTransactionProcessed',
        aggregateId: 'aggregate-456',
        correlationId: 'correlation-789',
        causationId: 'causation-321',
        occurredAt: '2026-11-10T10:30:00.000Z',
        version: 1,
        data: {
          transactionId: 'transaction-123',
          amount: '100.00',
          currency: 'BRL',
        },
      });
    });

    it('deve omitir causationId quando não informado', () => {
      const event = new WagerTransactionProcessed({
        ...baseEventProps,
        causationId: undefined,
      });

      expect(event.causationId).toBeNull();
      expect(event.toJSON()).not.toHaveProperty('causationId');
    });

    it('deve preservar a data original sem compartilhar sua referência', () => {
      const originalDate = new Date(occurredAt);

      const event = new WagerTransactionProcessed({
        ...baseEventProps,
        occurredAt: originalDate,
      });

      originalDate.setFullYear(2030);

      expect(event.occurredAt.toISOString()).toBe(
        '2026-11-10T10:30:00.000Z',
      );
    });

    it('deve impedir alterações diretas nos dados do evento', () => {
      const event = new WagerTransactionProcessed(baseEventProps);

      expect(Object.isFrozen(event.data)).toBe(true);
    });
  });

  describe('Validação do envelope', () => {
    it.each([
      ['eventId vazio', { eventId: '' }],
      ['aggregateId vazio', { aggregateId: '' }],
      ['correlationId vazio', { correlationId: '' }],
      ['data nulo', { data: null }],
      ['data como array', { data: [] }],
      ['data como string', { data: 'inválido' }],
      ['data como número', { data: 123 }],
      ['data como booleano', { data: true }],
      ['data como objeto nulo', { data: undefined }],
      ['data com data inválida', { occurredAt: new Date('invalid') }],
    ])('deve rejeitar %s', (_description, overrides) => {
      expect(() => {
        new WagerTransactionProcessed({
          ...baseEventProps,
          ...overrides,
        } as IntegrationEventProps<Record<string, unknown>>);
      }).toThrow('Os dados obrigatórios do evento são inválidos.');
    });

    it('deve rejeitar causationId vazio com mensagem específica', () => {
      expect(() => {
        new WagerTransactionProcessed({
          ...baseEventProps,
          causationId: '',
        });
      }).toThrow('O causationId informado é inválido.');
    });

    it('deve rejeitar occurredAt que não seja uma data', () => {
      expect(() => {
        new WagerTransactionProcessed({
          ...baseEventProps,
          occurredAt: '2026-11-10' as unknown as Date,
        });
      }).toThrow('Os dados obrigatórios do evento são inválidos.');
    });
  });

  describe('Classes concretas', () => {
    it.each([
      ['WagerTransactionProcessed', WagerTransactionProcessed],
      ['WagerTransactionRejected', WagerTransactionRejected],
      ['WagerTransactionPendingReference', WagerTransactionPendingReference],
      ['WagerTransactionReferenceExpired', WagerTransactionReferenceExpired],
    ])('deve identificar corretamente o evento %s', (eventType, EventClass) => {
      const event = new EventClass(baseEventProps);

      expect(event.eventType).toBe(eventType);
      expect(event.version).toBe(1);
    });
  });

  describe('createIntegrationEvent', () => {
    it.each([
      ['WagerTransactionProcessed', WagerTransactionProcessed],
      ['WagerTransactionRejected', WagerTransactionRejected],
      ['WagerTransactionPendingReference', WagerTransactionPendingReference],
      ['WagerTransactionReferenceExpired', WagerTransactionReferenceExpired],
    ] as const)(
      'deve criar a classe concreta para %s',
      (eventType, EventClass) => {
        const event = createIntegrationEvent(eventType, {
          eventId: 'event-factory-123',
          aggregateId: 'aggregate-factory-456',
          correlationId: 'correlation-factory-789',
          data: {
            transactionId: 'transaction-factory-123',
          },
          occurredAt,
        });

        expect(event).toBeInstanceOf(EventClass);
        expect(event.eventType).toBe(eventType);
        expect(event.id).toBe('event-factory-123');
      },
    );
  });
});

describe('WalletBalanceChanged', () => {
  // Cria um objeto monetário mínimo para testar a conversão do evento.
  const createMoneyMock = (amount: string, currency = 'BRL') => ({
    toJSON: () => ({
      amount,
      currency,
    }),
    equals: () => true,
  });

  it('deve construir o evento com os dados da wallet e do ledger', () => {
    const balance = createMoneyMock('150.00');
    const balanceBefore = createMoneyMock('100.00');
    const amount = createMoneyMock('50.00');

    const wallet = {
      id: 'wallet-123',
      currency: 'BRL',
      version: 2,
      balance: balance as unknown as Money,
    } as Wallet;

    const entry = {
      walletId: 'wallet-123',
      transactionId: 'transaction-123',
      direction: WalletLedgerDirection.CREDIT,
      currency: 'BRL',
      amount: amount as unknown as Money,
      balanceBefore: balanceBefore as unknown as Money,
      balanceAfter: balance as unknown as Money,
    } as WalletLedgerEntry;

    const event = WalletBalanceChanged.from(wallet, entry, {
      eventId: 'balance-event-123',
      correlationId: 'correlation-123',
      causationId: 'transaction-123',
      occurredAt,
    });

    expect(event).toBeInstanceOf(WalletBalanceChanged);
    expect(event.eventId).toBe('balance-event-123');
    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe('wallet-123');
    expect(event.correlationId).toBe('correlation-123');
    expect(event.causationId).toBe('transaction-123');

    expect(event.data).toEqual({
      walletId: 'wallet-123',
      transactionId: 'transaction-123',
      direction: WalletLedgerDirection.CREDIT,
      money: {
        amount: '50.00',
        currency: 'BRL',
      },
      balanceBefore: {
        amount: '100.00',
        currency: 'BRL',
      },
      balanceAfter: {
        amount: '150.00',
        currency: 'BRL',
      },
      walletVersion: 2,
    });
  });

  it('deve rejeitar lançamento pertencente a outra wallet', () => {
    const balance = createMoneyMock('150.00');

    const wallet = {
      id: 'wallet-123',
      currency: 'BRL',
      version: 2,
      balance: balance as unknown as Money,
    } as Wallet;

    const entry = {
      walletId: 'wallet-diferente',
      transactionId: 'transaction-123',
      currency: 'BRL',
      amount: createMoneyMock('50.00') as unknown as Money,
      balanceBefore: createMoneyMock('100.00') as unknown as Money,
      balanceAfter: balance as unknown as Money,
    } as WalletLedgerEntry;

    expect(() => {
      WalletBalanceChanged.from(wallet, entry, {
        correlationId: 'correlation-123',
      });
    }).toThrow(
      'O lançamento deve corresponder ao estado atual da wallet.',
    );
  });

  it('deve rejeitar lançamento com moeda diferente da wallet', () => {
    const balance = createMoneyMock('150.00');

    const wallet = {
      id: 'wallet-123',
      currency: 'BRL',
      version: 2,
      balance: balance as unknown as Money,
    } as Wallet;

    const entry = {
      walletId: 'wallet-123',
      transactionId: 'transaction-123',
      currency: 'USD',
      amount: createMoneyMock('50.00', 'USD') as unknown as Money,
      balanceBefore: createMoneyMock('100.00') as unknown as Money,
      balanceAfter: balance as unknown as Money,
    } as WalletLedgerEntry;

    expect(() => {
      WalletBalanceChanged.from(wallet, entry, {
        correlationId: 'correlation-123',
      });
    }).toThrow(
      'O lançamento deve corresponder ao estado atual da wallet.',
    );
  });
});

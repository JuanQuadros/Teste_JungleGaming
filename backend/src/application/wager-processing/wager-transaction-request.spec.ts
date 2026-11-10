import { describe, expect, it } from 'vitest';
import {
  InvalidWagerRequestError,
  parseQueueWagerTransactionMessage,
} from './wager-transaction-request.js';

const transaction = {
  providerId: 'provider-1',
  externalTransactionId: 'external-1',
  walletId: '00000000-0000-4000-8000-000000000001',
  playerId: '00000000-0000-4000-8000-000000000002',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  amount: '10.5',
  currency: 'BRL',
};

describe('SQS wager transaction message', () => {
  it('validates the envelope with the same normalized transaction contract as HTTP', () => {
    expect(
      parseQueueWagerTransactionMessage({
        idempotencyKey: 'queue-message-1',
        transaction,
      }),
    ).toEqual({
      idempotencyKey: 'queue-message-1',
      transaction: { ...transaction, amount: '10.50' },
    });
  });

  it('rejects unknown envelope fields and invalid idempotency keys', () => {
    expect(() =>
      parseQueueWagerTransactionMessage({
        idempotencyKey: 'invalid key',
        transaction,
        unexpected: true,
      }),
    ).toThrowError(InvalidWagerRequestError);
  });
});

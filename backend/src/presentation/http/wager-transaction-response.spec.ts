import { describe, expect, it } from 'vitest';
import { Money } from '../../domain/money.js';
import { WagerTransactionStatus } from '../../domain/wager-transaction.js';
import { mapWagerTransactionResponse } from './wager-transaction-response.js';

describe('mapWagerTransactionResponse', () => {
  it.each([
    [WagerTransactionStatus.PROCESSED, null, 200, 'PROCESSED'],
    [WagerTransactionStatus.PENDING, null, 202, 'PROCESSING_PENDING'],
    [WagerTransactionStatus.PENDING_REFERENCE, null, 202, 'PROCESSING_PENDING'],
    [
      WagerTransactionStatus.REJECTED,
      'INSUFFICIENT_BALANCE',
      422,
      'INSUFFICIENT_BALANCE',
    ],
    [
      WagerTransactionStatus.FAILED,
      'PROCESSING_FAILED',
      500,
      'PROCESSING_FAILED',
    ],
  ] as const)(
    'mapeia %s para HTTP %i com código estável',
    (status, failureCode, statusCode, code) => {
      expect(
        mapWagerTransactionResponse({
          id: 'transaction-1',
          status,
          failureCode,
          responseBalance: Money.from({ amount: '12.34', currency: 'BRL' }),
        }),
      ).toEqual({
        statusCode,
        body: {
          transactionId: 'transaction-1',
          status,
          code,
          balance: '12.34',
          idempotentReplay: false,
        },
      });
    },
  );

  it('marks a response returned from a persistent idempotency replay', () => {
    expect(
      mapWagerTransactionResponse(
        {
          id: 'transaction-1',
          status: WagerTransactionStatus.PROCESSED,
          failureCode: null,
          responseBalance: null,
        },
        true,
      ).body.idempotentReplay,
    ).toBe(true);
  });
});

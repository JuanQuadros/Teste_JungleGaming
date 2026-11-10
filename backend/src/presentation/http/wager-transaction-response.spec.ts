import { describe, expect, it } from 'vitest';
import { WagerTransactionStatus } from '../../domain/wager-transaction.js';
import { mapWagerTransactionResponse } from './wager-transaction-response.js';

describe('mapWagerTransactionResponse', () => {
  it.each([
    [WagerTransactionStatus.PROCESSED, null, 200, 'PROCESSED'],
    [WagerTransactionStatus.PENDING, null, 202, 'PROCESSING_PENDING'],
    [
      WagerTransactionStatus.PENDING_REFERENCE,
      null,
      202,
      'PROCESSING_PENDING',
    ],
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
        }),
      ).toEqual({
        statusCode,
        body: { transactionId: 'transaction-1', status, code },
      });
    },
  );
});

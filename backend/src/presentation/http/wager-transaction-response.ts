import { WagerTransactionStatus } from '../../domain/wager-transaction.js';
import type { Money } from '../../domain/money.js';

export interface WagerTransactionResult {
  id: string;
  status: WagerTransactionStatus;
  failureCode: string | null;
  responseBalance: Money | null;
}

export interface WagerTransactionHttpResponse {
  statusCode: 200 | 202 | 422 | 500;
  body: {
    transactionId: string;
    status: WagerTransactionStatus;
    code: string;
    balance: { amount: string; currency: string } | null;
    idempotentReplay: boolean;
  };
}

/** Mapeia o resultado de domínio para códigos HTTP sem depender de mensagens. */
export function mapWagerTransactionResponse(
  transaction: WagerTransactionResult,
  idempotentReplay = false,
): WagerTransactionHttpResponse {
  switch (transaction.status) {
    case WagerTransactionStatus.PROCESSED:
      return {
        statusCode: 200,
        body: {
          transactionId: transaction.id,
          status: transaction.status,
          code: 'PROCESSED',
          balance: transaction.responseBalance?.toJSON() ?? null,
          idempotentReplay,
        },
      };
    case WagerTransactionStatus.PENDING:
    case WagerTransactionStatus.PENDING_REFERENCE:
      return {
        statusCode: 202,
        body: {
          transactionId: transaction.id,
          status: transaction.status,
          code: 'PROCESSING_PENDING',
          balance: transaction.responseBalance?.toJSON() ?? null,
          idempotentReplay,
        },
      };
    case WagerTransactionStatus.REJECTED:
      return {
        statusCode: 422,
        body: {
          transactionId: transaction.id,
          status: transaction.status,
          code: transaction.failureCode ?? 'WAGER_REJECTED',
          balance: transaction.responseBalance?.toJSON() ?? null,
          idempotentReplay,
        },
      };
    case WagerTransactionStatus.FAILED:
      return {
        statusCode: 500,
        body: {
          transactionId: transaction.id,
          status: transaction.status,
          code: 'PROCESSING_FAILED',
          balance: transaction.responseBalance?.toJSON() ?? null,
          idempotentReplay,
        },
      };
  }
}

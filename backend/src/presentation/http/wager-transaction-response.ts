import { WagerTransactionStatus } from '../../domain/wager-transaction.js';

export interface WagerTransactionResult {
  id: string;
  status: WagerTransactionStatus;
  failureCode: string | null;
}

export interface WagerTransactionHttpResponse {
  statusCode: 200 | 202 | 422 | 500;
  body: {
    transactionId: string;
    status: WagerTransactionStatus;
    code: string;
  };
}

/** Mapeia o resultado de domínio para códigos HTTP sem depender de mensagens. */
export function mapWagerTransactionResponse(
  transaction: WagerTransactionResult,
): WagerTransactionHttpResponse {
  switch (transaction.status) {
    case WagerTransactionStatus.PROCESSED:
      return {
        statusCode: 200,
        body: {
          transactionId: transaction.id,
          status: transaction.status,
          code: 'PROCESSED',
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
        },
      };
    case WagerTransactionStatus.REJECTED:
      return {
        statusCode: 422,
        body: {
          transactionId: transaction.id,
          status: transaction.status,
          code: transaction.failureCode ?? 'WAGER_REJECTED',
        },
      };
    case WagerTransactionStatus.FAILED:
      return {
        statusCode: 500,
        body: {
          transactionId: transaction.id,
          status: transaction.status,
          code: 'PROCESSING_FAILED',
        },
      };
  }
}

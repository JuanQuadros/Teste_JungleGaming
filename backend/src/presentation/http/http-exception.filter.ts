import {
  ArgumentsHost,
  Catch,
  HttpException,
  Injectable,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { InvalidMoneyError } from '../../domain/money.js';
import { InvalidWagerTransactionError } from '../../domain/wager-transaction.js';
import { RequestContext } from '../../observability/request-context.js';
import { StructuredLogger } from '../../observability/structured-logger.js';
import {
  IdempotencyConflictError,
  TransientInfrastructureError,
} from './http-api-error.js';
import { InvalidWagerRequestError } from '../../application/wager-processing/wager-transaction-request.js';
import { WalletAlreadyExistsError } from '../../application/wallet-management/wallet-already-exists.error.js';

interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  correlationId?: string;
}

@Catch()
@Injectable()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly requestContext: RequestContext,
    private readonly logger: StructuredLogger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const correlationId = this.requestContext.correlationId;
    const mapped = this.mapException(exception);

    this.logger.errorEvent('http_request_failed', {
      errorName: exception instanceof Error ? exception.name : 'UnknownError',
      errorCode: mapped.code,
      statusCode: mapped.statusCode,
    });

    const body: ApiErrorResponse = {
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details === undefined ? {} : { details: mapped.details }),
      },
      ...(correlationId ? { correlationId } : {}),
    };
    response.status(mapped.statusCode).json(body);
  }

  private mapException(exception: unknown): {
    statusCode: number;
    code: string;
    message: string;
    details?: unknown;
  } {
    if (exception instanceof InvalidWagerRequestError) {
      return {
        statusCode: 400,
        code: 'INVALID_REQUEST',
        message: 'A solicitação contém campos inválidos.',
        details: exception.issues,
      };
    }
    if (
      exception instanceof InvalidMoneyError ||
      exception instanceof InvalidWagerTransactionError
    ) {
      return {
        statusCode: 400,
        code: 'INVALID_REQUEST',
        message: 'A solicitação contém campos inválidos.',
      };
    }
    if (exception instanceof IdempotencyConflictError) {
      return {
        statusCode: 409,
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'A chave de idempotência foi reutilizada com outros dados.',
      };
    }
    if (exception instanceof WalletAlreadyExistsError) {
      return {
        statusCode: 409,
        code: 'WALLET_ALREADY_EXISTS',
        message: 'Já existe uma wallet para este jogador e moeda.',
      };
    }
    if (exception instanceof TransientInfrastructureError) {
      return {
        statusCode: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: 'O serviço está temporariamente indisponível.',
      };
    }
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const response = exception.getResponse();
      const details =
        typeof response === 'object' &&
        response !== null &&
        'checks' in response
          ? { checks: response.checks }
          : undefined;
      return {
        statusCode,
        code: this.httpCode(statusCode),
        message: this.httpMessage(statusCode),
        ...(details === undefined ? {} : { details }),
      };
    }
    return {
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Ocorreu um erro interno.',
    };
  }

  private httpCode(statusCode: number): string {
    switch (statusCode) {
      case 400:
        return 'INVALID_REQUEST';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 422:
        return 'WAGER_REJECTED';
      case 429:
        return 'RATE_LIMITED';
      case 503:
        return 'SERVICE_UNAVAILABLE';
      default:
        return statusCode >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR';
    }
  }

  private httpMessage(statusCode: number): string {
    if (statusCode === 400) return 'A solicitação contém campos inválidos.';
    if (statusCode === 404) return 'O recurso solicitado não foi encontrado.';
    if (statusCode === 409) return 'A solicitação conflita com o estado atual.';
    if (statusCode === 422)
      return 'A operação foi rejeitada pelas regras de negócio.';
    if (statusCode === 503)
      return 'O serviço está temporariamente indisponível.';
    if (statusCode >= 500) return 'Ocorreu um erro interno.';
    return 'A solicitação não pode ser processada.';
  }
}

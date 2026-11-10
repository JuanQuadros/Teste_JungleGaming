import {
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import type { Request } from 'express';
import { InvalidWagerRequestError } from './wager-transaction-request.dto.js';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context
      .switchToHttp()
      .getRequest<Request>()
      .headers['idempotency-key'],
);

/** Valida o header autoritativo de idempotência antes de iniciar o caso de uso. */
@Injectable()
export class IdempotencyKeyPipe implements PipeTransform<unknown, string> {
  transform(value: unknown, _metadata: ArgumentMetadata): string {
    if (
      typeof value !== 'string' ||
      !IDEMPOTENCY_KEY_PATTERN.test(value)
    ) {
      throw new InvalidWagerRequestError([
        { field: 'Idempotency-Key', code: 'INVALID_IDEMPOTENCY_KEY' },
      ]);
    }
    return value;
  }
}

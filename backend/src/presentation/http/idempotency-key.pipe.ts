import {
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import type { Request } from 'express';
import { parseIdempotencyKey } from '../../application/wager-processing/wager-transaction-request.js';

export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<Request>().headers['idempotency-key'],
);

/** Valida o header autoritativo de idempotência antes de iniciar o caso de uso. */
@Injectable()
export class IdempotencyKeyPipe implements PipeTransform<unknown, string> {
  transform(value: unknown, _metadata: ArgumentMetadata): string {
    return parseIdempotencyKey(value);
  }
}

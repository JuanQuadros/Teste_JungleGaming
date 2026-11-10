import {
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import {
  parseWagerTransactionRequest,
  type WagerTransactionRequestDto,
} from './wager-transaction-request.dto.js';

/** Valida o corpo externo antes de entregá-lo ao controller ou caso de uso. */
@Injectable()
export class WagerTransactionRequestPipe
  implements PipeTransform<unknown, WagerTransactionRequestDto>
{
  transform(
    value: unknown,
    _metadata: ArgumentMetadata,
  ): WagerTransactionRequestDto {
    return parseWagerTransactionRequest(value);
  }
}

import {
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import {
  parseCreateWalletRequest,
  type CreateWalletRequestDto,
} from './create-wallet-request.dto.js';

@Injectable()
export class CreateWalletRequestPipe implements PipeTransform<
  unknown,
  CreateWalletRequestDto
> {
  transform(
    value: unknown,
    _metadata: ArgumentMetadata,
  ): CreateWalletRequestDto {
    return parseCreateWalletRequest(value);
  }
}

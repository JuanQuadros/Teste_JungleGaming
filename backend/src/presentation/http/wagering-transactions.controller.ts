import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepositoryPort,
} from '../../application/ports/persistence.repositories.js';
import { SubmitWagerTransactionUseCase } from '../../application/wager-processing/submit-wager-transaction.use-case.js';
import { WagerTransaction } from '../../domain/wager-transaction.js';
import { IdempotencyKey, IdempotencyKeyPipe } from './idempotency-key.pipe.js';
import { WagerTransactionRequestPipe } from './wager-transaction-request.pipe.js';
import {
  InvalidWagerRequestError,
  type WagerTransactionRequestDto,
} from '../../application/wager-processing/wager-transaction-request.js';
import { mapWagerTransactionResponse } from './wager-transaction-response.js';

@Controller('wagering/transactions')
export class WageringTransactionsController {
  constructor(
    private readonly submitTransaction: SubmitWagerTransactionUseCase,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepositoryPort,
  ) {}

  @Post()
  async submit(
    @Body(WagerTransactionRequestPipe) body: WagerTransactionRequestDto,
    @IdempotencyKey(IdempotencyKeyPipe) idempotencyKey: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.submitTransaction.execute(body, idempotencyKey);
    const mapped = mapWagerTransactionResponse(result);
    response.status(mapped.statusCode);
    return mapped.body;
  }

  @Get('by-external')
  async getByExternalIdentity(
    @Query('providerId') providerId?: string,
    @Query('externalTransactionId') externalTransactionId?: string,
  ) {
    if (
      typeof providerId !== 'string' ||
      providerId.trim().length === 0 ||
      providerId.length > 256
    ) {
      throw new InvalidWagerRequestError([
        { field: 'providerId', code: 'NON_EMPTY_STRING_REQUIRED' },
      ]);
    }
    if (
      typeof externalTransactionId !== 'string' ||
      externalTransactionId.trim().length === 0 ||
      externalTransactionId.length > 256
    ) {
      throw new InvalidWagerRequestError([
        {
          field: 'externalTransactionId',
          code: 'NON_EMPTY_STRING_REQUIRED',
        },
      ]);
    }
    const transaction = await this.transactions.findByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
    if (!transaction) throw new NotFoundException();
    return this.toResource(transaction);
  }

  @Get(':transactionId')
  async getById(
    @Param('transactionId', new ParseUUIDPipe()) transactionId: string,
  ) {
    const transaction = await this.transactions.findById(transactionId);
    if (!transaction) throw new NotFoundException();
    return this.toResource(transaction);
  }

  private toResource(transaction: WagerTransaction) {
    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount: transaction.amount.toJSON().amount,
      currency: transaction.currency,
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId,
      referenceTransactionId: transaction.referenceTransactionId,
      status: transaction.status,
      failureCode: transaction.failureCode,
      balance: transaction.responseBalance?.toJSON().amount ?? null,
    };
  }
}

import {
  Body,
  Controller,
  Get,
  Module,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../observability/request-context.js';
import { StructuredLogger } from '../../observability/structured-logger.js';
import { HttpExceptionFilter } from './http-exception.filter.js';
import {
  IdempotencyConflictError,
  TransientInfrastructureError,
} from './http-api-error.js';
import {
  IdempotencyKey,
  IdempotencyKeyPipe,
} from './idempotency-key.pipe.js';
import { InvalidWagerRequestError } from './wager-transaction-request.dto.js';
import { WagerTransactionRequestPipe } from './wager-transaction-request.pipe.js';

@Controller('contracts')
class WagerHttpContractsController {
  @Post('transactions')
  submit(
    @Body(WagerTransactionRequestPipe) body: unknown,
    @IdempotencyKey(IdempotencyKeyPipe) idempotencyKey: string,
  ) {
    return { body, idempotencyKey };
  }

  @Get('conflict')
  conflict(): never {
    throw new IdempotencyConflictError();
  }

  @Get('unavailable')
  unavailable(): never {
    throw new TransientInfrastructureError();
  }

  @Get('invalid')
  invalid(): never {
    throw new InvalidWagerRequestError([
      { field: 'amount', code: 'DECIMAL_STRING_REQUIRED' },
    ]);
  }

  @Get('unexpected')
  unexpected(): never {
    throw new Error('sensitive database detail');
  }
}

@Module({
  controllers: [WagerHttpContractsController],
})
class WagerHttpContractsModule {}

describe('Wager HTTP contracts', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WagerHttpContractsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    const context = new RequestContext();
    const logger = new StructuredLogger(context);
    vi.spyOn(logger, 'errorEvent').mockImplementation(() => {});
    app.useGlobalFilters(new HttpExceptionFilter(context, logger));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('valida o body e o header antes de executar o controller', async () => {
    const response = await request(app.getHttpServer())
      .post('/contracts/transactions')
      .set('idempotency-key', 'request-123')
      .send({
        providerId: 'provider-1',
        externalTransactionId: 'external-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        amount: '10.5',
        currency: 'BRL',
      })
      .expect(201);

    expect(response.body).toEqual({
      body: {
        providerId: 'provider-1',
        externalTransactionId: 'external-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        amount: '10.50',
        currency: 'BRL',
      },
      idempotencyKey: 'request-123',
    });
  });

  it.each([
    [
      { kind: 'OPENING' },
      'request-123',
      'UNSUPPORTED_TRANSACTION_TYPE',
    ],
    [
      { kind: 'REFUND' },
      'request-123',
      'REFERENCE_REQUIRED',
    ],
    [
      { kind: 'BET', amount: 10 },
      'request-123',
      'DECIMAL_STRING_REQUIRED',
    ],
    [{ kind: 'BET' }, '', 'INVALID_IDEMPOTENCY_KEY'],
    [{ kind: 'BET', extra: true }, 'request-123', 'UNKNOWN_FIELD'],
  ])(
    'rejeita entrada inválida com código estável %s',
    async (overrides, idempotencyKey, expectedCode) => {
      const body = {
        providerId: 'provider-1',
        externalTransactionId: 'external-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        amount: '10.00',
        currency: 'BRL',
        ...overrides,
      };
      const response = await request(app.getHttpServer())
        .post('/contracts/transactions')
        .set('idempotency-key', idempotencyKey)
        .send(body)
        .expect(400);

      expect(response.body.error.code).toBe('INVALID_REQUEST');
      expect(response.body.error.details).toContainEqual(
        expect.objectContaining({ code: expectedCode }),
      );
    },
  );

  it.each([
    ['/contracts/conflict', 409, 'IDEMPOTENCY_CONFLICT'],
    ['/contracts/unavailable', 503, 'SERVICE_UNAVAILABLE'],
    ['/contracts/invalid', 400, 'INVALID_REQUEST'],
    ['/contracts/unexpected', 500, 'INTERNAL_ERROR'],
  ])('mapeia %s para resposta de erro estável', async (path, status, code) => {
    const response = await request(app.getHttpServer())
      .get(path)
      .expect(status);
    expect(response.body.error.code).toBe(code);
    expect(response.text).not.toContain('sensitive database detail');
  });
});

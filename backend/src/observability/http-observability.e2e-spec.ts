import {
  Controller,
  Get,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpObservabilityMiddleware } from './http-observability.middleware.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';
import { RequestContext } from './request-context.js';
import { StructuredLogger } from './structured-logger.js';

@Controller('probe')
class ProbeController {
  @Get(':id')
  getProbe() {
    return { status: 'ok' };
  }
}

@Module({
  controllers: [ProbeController, MetricsController],
  providers: [
    RequestContext,
    MetricsService,
    HttpObservabilityMiddleware,
    { provide: StructuredLogger, useValue: { info: vi.fn() } },
  ],
})
class ObservabilityTestModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(HttpObservabilityMiddleware)
      .forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}

describe('HTTP observability', () => {
  let server: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ObservabilityTestModule],
    }).compile();
    const nestApp = moduleRef.createNestApplication();
    await nestApp.init();
    server = nestApp;
  });

  afterAll(async () => {
    await server.close();
  });

  it('propaga um correlation ID válido na resposta', async () => {
    const correlationId = randomUUID();

    await request(server.getHttpServer())
      .get('/probe/transaction-123')
      .set('x-correlation-id', correlationId)
      .expect(200)
      .expect('x-correlation-id', correlationId);
  });

  it('substitui um correlation ID inválido por UUID', async () => {
    const response = await request(server.getHttpServer())
      .get('/probe/transaction-123')
      .set('x-correlation-id', 'invalid id')
      .expect(200);

    expect(response.headers['x-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('expõe métricas sem incluir valores dinâmicos da rota', async () => {
    const response = await request(server.getHttpServer())
      .get('/probe/transaction-secret')
      .expect(200);
    const metrics = await request(server.getHttpServer())
      .get('/metrics')
      .expect('content-type', /text\/plain/)
      .expect(200);

    expect(metrics.text).toMatch(
      /http_server_requests_total\{method="GET",route="\/probe\/:id",status_code="200"\} [1-9]\d*/,
    );
    expect(metrics.text).not.toContain('transaction-secret');
    expect(response.headers['x-correlation-id']).toBeTruthy();
  });
});

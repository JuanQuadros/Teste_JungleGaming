import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { MetricsService } from './metrics.service.js';
import { RequestContext } from './request-context.js';
import { StructuredLogger } from './structured-logger.js';

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

@Injectable()
export class HttpObservabilityMiddleware {
  constructor(
    private readonly requestContext: RequestContext,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLogger,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const requestedId = request.header('x-correlation-id');
    const correlationId =
      requestedId && CORRELATION_ID_PATTERN.test(requestedId)
        ? requestedId
        : randomUUID();
    const startedAt = process.hrtime.bigint();

    response.setHeader('x-correlation-id', correlationId);
    this.requestContext.run(correlationId, () => {
      response.once('finish', () => {
        const durationSeconds =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
        const route = this.routeTemplate(request);

        if (route !== '/metrics') {
          this.metrics.recordHttpRequest(
            request.method,
            route,
            response.statusCode,
            durationSeconds,
          );
          this.logger.info('http_request_completed', {
            method: request.method,
            route,
            statusCode: response.statusCode,
            durationSeconds,
          });
        }
      });
      next();
    });
  }

  private routeTemplate(request: Request): string {
    if (!request.route?.path) return 'unmatched';
    const routePath =
      typeof request.route.path === 'string'
        ? request.route.path
        : request.route.path.join('|');
    return `${request.baseUrl}${routePath}` || '/';
  }
}

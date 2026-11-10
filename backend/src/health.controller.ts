import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MetricsService } from './observability/metrics.service.js';

@Controller('health')
export class HealthController {
  // Usa a mesma conexão ORM da aplicação para informar se o banco está pronto.
  constructor(
    private readonly orm: MikroORM,
    private readonly sqsClient: SQSClient,
    private readonly metrics: MetricsService,
  ) {}

  // A verificação de atividade confirma apenas se o processo responde a requisições HTTP.
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  // A verificação de prontidão consulta o PostgreSQL para evitar tráfego numa instância indisponível.
  @Get('ready')
  async ready() {
    // Consulta o banco e as duas filas para não anunciar prontidão parcial.
    const results = await Promise.allSettled([
      this.orm.em.getConnection().execute('select 1'),
      this.sqsClient.send(
        new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }),
      ),
      this.sqsClient.send(
        new GetQueueUrlCommand({ QueueName: 'wager-transactions-dlq.fifo' }),
      ),
      this.sqsClient.send(
        new GetQueueUrlCommand({ QueueName: 'wager-events.fifo' }),
      ),
      this.sqsClient.send(
        new GetQueueUrlCommand({ QueueName: 'wager-events-dlq.fifo' }),
      ),
    ]);

    const checkStatus = (
      result: PromiseSettledResult<unknown>,
    ): 'ok' | 'unavailable' =>
      result.status === 'fulfilled' ? 'ok' : 'unavailable';
    const checks: Record<string, 'ok' | 'unavailable'> = {
      postgres: checkStatus(results[0]),
      transactionsQueue: checkStatus(results[1]),
      deadLetterQueue: checkStatus(results[2]),
      eventsQueue: checkStatus(results[3]),
      eventsDeadLetterQueue: checkStatus(results[4]),
    };
    this.metrics.recordHealthCheck('postgres', checks.postgres);
    this.metrics.recordHealthCheck(
      'transactions_queue',
      checks.transactionsQueue,
    );
    this.metrics.recordHealthCheck('dead_letter_queue', checks.deadLetterQueue);
    this.metrics.recordHealthCheck('events_queue', checks.eventsQueue);
    this.metrics.recordHealthCheck(
      'events_dead_letter_queue',
      checks.eventsDeadLetterQueue,
    );

    if (Object.values(checks).some((status) => status !== 'ok')) {
      throw new ServiceUnavailableException({
        status: 'error',
        checks,
      });
    }

    return { status: 'ok', checks };
  }
}

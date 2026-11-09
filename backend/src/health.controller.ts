import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

@Controller('health')
export class HealthController {
  // Usa a mesma conexão ORM da aplicação para informar se o banco está pronto.
  constructor(
    private readonly orm: MikroORM,
    private readonly sqsClient: SQSClient,
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
    ]);

    const checks = {
      postgres: results[0].status === 'fulfilled' ? 'ok' : 'unavailable',
      transactionsQueue: results[1].status === 'fulfilled' ? 'ok' : 'unavailable',
      deadLetterQueue: results[2].status === 'fulfilled' ? 'ok' : 'unavailable',
    };

    if (Object.values(checks).some((status) => status !== 'ok')) {
      throw new ServiceUnavailableException({
        status: 'error',
        checks,
      });
    }

    return { status: 'ok', checks };
  }
}

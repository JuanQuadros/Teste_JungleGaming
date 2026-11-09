import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectMikroORM } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';

@Controller('health')
export class HealthController {
  // Use the same ORM connection as the application to report database readiness.
  constructor(@InjectMikroORM('default') private readonly orm: MikroORM) {}

  // Liveness checks only whether this process can answer HTTP requests.
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  // Readiness checks PostgreSQL so traffic is not sent to an unready instance.
  @Get('ready')
  async ready() {
    try {
      await this.orm.em.getConnection().execute('select 1');
      return { status: 'ok', checks: { postgres: 'ok' } };
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        checks: { postgres: 'unavailable' },
      });
    }
  }
}

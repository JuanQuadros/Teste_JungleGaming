import { NestFactory } from '@nestjs/core';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { RequestContext } from './observability/request-context.js';
import { StructuredLogger } from './observability/structured-logger.js';
import { HttpExceptionFilter } from './presentation/http/http-exception.filter.js';

// Carrega o arquivo local antes de importar módulos que leem as variáveis na inicialização.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

// A importação dinâmica garante que o MikroORM receba as variáveis já carregadas.
const { AppModule } = await import('./app.module.js');

async function bootstrap() {
  const logger = new StructuredLogger(new RequestContext());
  const app = await NestFactory.create(AppModule, { logger });
  app.useGlobalFilters(
    new HttpExceptionFilter(app.get(RequestContext), app.get(StructuredLogger)),
  );
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();

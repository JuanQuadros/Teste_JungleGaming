import { NestFactory } from '@nestjs/core';
import { existsSync } from 'node:fs';
import process from 'node:process';

// Carrega o arquivo local antes de importar módulos que leem as variáveis na inicialização.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

// A importação dinâmica garante que o MikroORM receba as variáveis já carregadas.
const { AppModule } = await import('./app.module.js');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();

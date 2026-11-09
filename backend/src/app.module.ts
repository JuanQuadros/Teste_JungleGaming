import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { mikroOrmConfig } from './mikro-orm.config.js';
import { HealthController } from './health.controller.js';
import { SQSClient } from '@aws-sdk/client-sqs';

// Compartilha o cliente AWS e permite apontá-lo ao LocalStack no ambiente local.
const sqsClientProvider = {
  provide: SQSClient,
  useFactory: () =>
    new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT_URL,
      credentials:
        process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
          ? {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            }
          : undefined,
    }),
};

@Module({
  // Registra uma conexão compartilhada com o banco para injeção nos provedores do NestJS.
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [AppController, HealthController],
  providers: [AppService, sqsClientProvider],
})
export class AppModule {}

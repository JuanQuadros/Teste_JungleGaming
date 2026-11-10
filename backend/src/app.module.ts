import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { mikroOrmConfig } from './mikro-orm.config.js';
import { HealthController } from './health.controller.js';
import { SQSClient } from '@aws-sdk/client-sqs';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';
import { HttpObservabilityMiddleware } from './observability/http-observability.middleware.js';
import { MetricsController } from './observability/metrics.controller.js';
import { MetricsService } from './observability/metrics.service.js';
import { RequestContext } from './observability/request-context.js';
import { StructuredLogger } from './observability/structured-logger.js';
import { ProcessWagerTransactionUseCase } from './application/wager-processing/process-wager-transaction.use-case.js';
import { CreateWalletUseCase } from './application/wallet-management/create-wallet.use-case.js';
import { WalletsController } from './presentation/http/wallets.controller.js';
import { WageringTransactionsController } from './presentation/http/wagering-transactions.controller.js';
import { RetryPendingReferencesUseCase } from './application/wager-processing/retry-pending-references.use-case.js';
import { PendingReferenceRetryWorker } from './infrastructure/workers/pending-reference-retry.worker.js';
import { ReconcileWalletUseCase } from './application/wallet-management/reconcile-wallet.use-case.js';
import { SubmitWagerTransactionUseCase } from './application/wager-processing/submit-wager-transaction.use-case.js';
import { WagerTransactionSqsConsumer } from './infrastructure/workers/wager-transaction-sqs.consumer.js';
import { OutboxSqsPublisherWorker } from './infrastructure/workers/outbox-sqs-publisher.worker.js';
import { SqsClientShutdownProvider } from './infrastructure/workers/sqs-client-shutdown.provider.js';
import { SqsDeadLetterQueueMetricsWorker } from './infrastructure/workers/sqs-dead-letter-queue-metrics.worker.js';

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
  imports: [MikroOrmModule.forRoot(mikroOrmConfig), PersistenceModule],
  controllers: [
    AppController,
    HealthController,
    MetricsController,
    WalletsController,
    WageringTransactionsController,
  ],
  providers: [
    AppService,
    ProcessWagerTransactionUseCase,
    SubmitWagerTransactionUseCase,
    CreateWalletUseCase,
    ReconcileWalletUseCase,
    RetryPendingReferencesUseCase,
    PendingReferenceRetryWorker,
    WagerTransactionSqsConsumer,
    OutboxSqsPublisherWorker,
    SqsDeadLetterQueueMetricsWorker,
    SqsClientShutdownProvider,
    sqsClientProvider,
    RequestContext,
    MetricsService,
    StructuredLogger,
    HttpObservabilityMiddleware,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(HttpObservabilityMiddleware)
      .forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}

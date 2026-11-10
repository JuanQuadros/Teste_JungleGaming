import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { RequestContext } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { createHash } from 'node:crypto';
import { SubmitWagerTransactionUseCase } from '../../application/wager-processing/submit-wager-transaction.use-case.js';
import { parseQueueWagerTransactionMessage } from '../../application/wager-processing/wager-transaction-request.js';
import { MetricsService } from '../../observability/metrics.service.js';
import { StructuredLogger } from '../../observability/structured-logger.js';

const QUEUE_NAME = 'wager-transactions.fifo';
const CONSUMER_NAME = 'wager-transactions';
const VISIBILITY_TIMEOUT_SECONDS = 60;
const MAX_RETRY_DELAY_SECONDS = 16;
const ERROR_RETRY_DELAY_MS = 1_000;

@Injectable()
export class WagerTransactionSqsConsumer
  implements OnModuleInit, OnModuleDestroy
{
  private stopping = false;
  private queueUrl: string | null = null;
  private readonly abortController = new AbortController();
  private consumeLoop: Promise<void> | null = null;

  constructor(
    private readonly sqsClient: SQSClient,
    private readonly entityManager: EntityManager,
    private readonly submitTransaction: SubmitWagerTransactionUseCase,
    private readonly metrics: MetricsService,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  onModuleInit(): void {
    this.consumeLoop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.abortController.abort();
    if (this.consumeLoop) await this.consumeLoop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const queueUrl = await this.resolveQueueUrl();
        const result = await this.sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 20,
            VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
          { abortSignal: this.abortController.signal },
        );
        const message = result.Messages?.[0];
        if (message) await this.handleMessage(queueUrl, message);
      } catch (error) {
        if (this.stopping) break;
        this.logger.errorEvent('sqs_wager_consumer_poll_failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        await this.delay(ERROR_RETRY_DELAY_MS);
      }
    }
  }

  private async resolveQueueUrl(): Promise<string> {
    if (this.queueUrl) return this.queueUrl;
    const configuredQueueUrl = process.env.WAGER_TRANSACTIONS_QUEUE_URL;
    if (configuredQueueUrl) {
      this.queueUrl = configuredQueueUrl;
      return configuredQueueUrl;
    }
    const result = await this.sqsClient.send(
      new GetQueueUrlCommand({ QueueName: QUEUE_NAME }),
      { abortSignal: this.abortController.signal },
    );
    if (!result.QueueUrl) {
      throw new Error(`SQS queue ${QUEUE_NAME} did not return a URL.`);
    }
    this.queueUrl = result.QueueUrl;
    return result.QueueUrl;
  }

  private async handleMessage(
    queueUrl: string,
    message: {
      MessageId?: string;
      ReceiptHandle?: string;
      Body?: string;
      Attributes?: Record<string, string>;
    },
  ): Promise<void> {
    const parsedReceiveCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? '1',
    );
    const receiveCount =
      Number.isFinite(parsedReceiveCount) && parsedReceiveCount > 0
        ? parsedReceiveCount
        : 1;
    const messageId = message.MessageId;
    const receiptHandle = message.ReceiptHandle;
    const body = message.Body;
    try {
      if (!messageId || !receiptHandle || !body) {
        throw new Error('SQS delivered a message without required attributes.');
      }
      const parsed = parseQueueWagerTransactionMessage(
        JSON.parse(body) as unknown,
      );
      const payloadHash = createHash('sha256')
        .update(
          JSON.stringify({
            idempotencyKey: parsed.idempotencyKey,
            transaction: parsed.transaction,
          }),
        )
        .digest('hex');

      await RequestContext.create(
        this.entityManager.fork({ useContext: true }),
        () =>
          this.submitTransaction.execute(
            parsed.transaction,
            parsed.idempotencyKey,
            {
              consumerName: CONSUMER_NAME,
              messageId,
              payloadHash,
            },
          ),
      );
      await this.sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
      if (receiveCount > 1) {
        this.metrics.recordRetry('sqs', 'succeeded');
      }
    } catch (error) {
      const retryScheduled = receiptHandle
        ? await this.deferRetry(queueUrl, receiptHandle, receiveCount)
        : false;
      this.metrics.recordRetry('sqs', retryScheduled ? 'scheduled' : 'failed');
      this.logger.errorEvent('sqs_wager_message_processing_failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        messageId: messageId ?? 'unknown',
        receiveCount,
        retryScheduled: retryScheduled ? 1 : 0,
      });
    }
  }

  private async deferRetry(
    queueUrl: string,
    receiptHandle: string,
    receiveCount: number,
  ): Promise<boolean> {
    const exponent = Math.max(0, Math.min(receiveCount - 1, 6));
    const delaySeconds = Math.min(2 ** exponent, MAX_RETRY_DELAY_SECONDS);
    try {
      await this.sqsClient.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: delaySeconds,
        }),
      );
      return true;
    } catch (error) {
      this.logger.errorEvent('sqs_wager_message_retry_schedule_failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        receiveCount,
      });
      return false;
    }
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

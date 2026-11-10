import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { MetricsService } from '../../observability/metrics.service.js';
import { StructuredLogger } from '../../observability/structured-logger.js';

const POLL_INTERVAL_MS = 15_000;
const QUEUES = [
  {
    label: 'transactions',
    name: 'wager-transactions-dlq.fifo',
  },
  {
    label: 'events',
    name: 'wager-events-dlq.fifo',
  },
] as const;
const DEPTH_ATTRIBUTES = [
  'ApproximateNumberOfMessages',
  'ApproximateNumberOfMessagesNotVisible',
  'ApproximateNumberOfMessagesDelayed',
] as const;

@Injectable()
export class SqsDeadLetterQueueMetricsWorker
  implements OnModuleInit, OnModuleDestroy
{
  private interval: ReturnType<typeof setInterval> | null = null;
  private currentPoll: Promise<void> | null = null;
  private readonly queueUrls = new Map<string, string>();
  private stopping = false;

  constructor(
    private readonly sqsClient: SQSClient,
    private readonly metrics: MetricsService,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  onModuleInit(): void {
    this.interval = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    if (this.currentPoll) await this.currentPoll;
  }

  private poll(): void {
    if (this.stopping || this.currentPoll) return;
    this.currentPoll = Promise.all(
      QUEUES.map((queue) => this.refreshQueue(queue)),
    )
      .then(() => undefined)
      .finally(() => {
        this.currentPoll = null;
      });
  }

  private async refreshQueue(queue: (typeof QUEUES)[number]): Promise<void> {
    try {
      const queueUrl = await this.resolveQueueUrl(queue.name);
      const result = await this.sqsClient.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: [...DEPTH_ATTRIBUTES],
        }),
      );
      const attributes = result.Attributes;
      const depth = DEPTH_ATTRIBUTES.reduce((total, attribute) => {
        const value = Number(attributes?.[attribute]);
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new Error(
            `SQS did not return a valid ${attribute} value for ${queue.name}.`,
          );
        }
        return total + value;
      }, 0);
      this.metrics.recordDeadLetterQueueDepth(queue.label, depth);
    } catch (error) {
      this.logger.errorEvent('sqs_dead_letter_queue_metrics_failed', {
        queue: queue.label,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  private async resolveQueueUrl(queueName: string): Promise<string> {
    const cachedUrl = this.queueUrls.get(queueName);
    if (cachedUrl) return cachedUrl;

    const result = await this.sqsClient.send(
      new GetQueueUrlCommand({ QueueName: queueName }),
    );
    if (!result.QueueUrl) {
      throw new Error(`SQS queue ${queueName} did not return a URL.`);
    }
    this.queueUrls.set(queueName, result.QueueUrl);
    return result.QueueUrl;
  }
}

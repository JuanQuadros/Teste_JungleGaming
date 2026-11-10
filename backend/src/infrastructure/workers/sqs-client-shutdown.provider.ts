import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';

@Injectable()
export class SqsClientShutdownProvider implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly sqsClient: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqsClient.destroy();
  }
}

import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContextStore {
  correlationId: string;
}

@Injectable()
export class RequestContext {
  private static readonly storage = new AsyncLocalStorage<RequestContextStore>();

  run<T>(correlationId: string, callback: () => T): T {
    return RequestContext.storage.run({ correlationId }, callback);
  }

  get correlationId(): string | undefined {
    return RequestContext.storage.getStore()?.correlationId;
  }
}

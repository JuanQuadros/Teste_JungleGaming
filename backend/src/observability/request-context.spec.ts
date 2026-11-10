import { describe, expect, it } from 'vitest';
import { RequestContext } from './request-context.js';

describe('RequestContext', () => {
  it('mantém o identificador de correlação isolado no contexto assíncrono', async () => {
    const context = new RequestContext();
    const result = await context.run('correlation-123', async () => {
      await Promise.resolve();
      return context.correlationId;
    });

    expect(result).toBe('correlation-123');
    expect(context.correlationId).toBeUndefined();
  });
});

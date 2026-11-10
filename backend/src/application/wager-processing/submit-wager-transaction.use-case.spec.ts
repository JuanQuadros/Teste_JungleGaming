import { describe, expect, it, vi } from 'vitest';
import { WagerTransactionStatus } from '../../domain/wager-transaction.js';
import { MetricsService } from '../../observability/metrics.service.js';
import { StructuredLogger } from '../../observability/structured-logger.js';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case.js';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case.js';

const request = {
  providerId: 'provider-1',
  externalTransactionId: 'external-1',
  walletId: '00000000-0000-4000-8000-000000000001',
  playerId: '00000000-0000-4000-8000-000000000002',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET' as const,
  amount: '10.00',
  currency: 'BRL',
};

describe('SubmitWagerTransactionUseCase observability', () => {
  it('records database lock conflicts without changing the original error', async () => {
    const error = { code: '40P01' };
    const metrics = new MetricsService();
    const processTransaction = {
      execute: vi.fn().mockRejectedValue(error),
    } as unknown as ProcessWagerTransactionUseCase;
    const submit = new SubmitWagerTransactionUseCase(
      processTransaction,
      metrics,
      { errorEvent: vi.fn() } as unknown as StructuredLogger,
    );

    await expect(submit.execute(request, 'idempotency-1')).rejects.toBe(error);

    expect(metrics.renderPrometheus()).toContain(
      'database_lock_conflicts_total{lock_type="transaction"} 1',
    );
  });

  it('counts an idempotent replay returned by the transaction use case', async () => {
    const metrics = new MetricsService();
    const processTransaction = {
      execute: vi.fn().mockResolvedValue({
        id: 'existing-transaction',
        walletId: request.walletId,
        providerId: request.providerId,
        status: WagerTransactionStatus.PROCESSED,
      }),
    } as unknown as ProcessWagerTransactionUseCase;
    const submit = new SubmitWagerTransactionUseCase(
      processTransaction,
      metrics,
      {
        info: vi.fn(),
        errorEvent: vi.fn(),
      } as unknown as StructuredLogger,
    );

    await submit.execute(request, 'idempotency-1');

    expect(metrics.renderPrometheus()).toContain(
      'wager_transaction_duplicates_total{source="http"} 1',
    );
  });
});

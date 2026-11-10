import { describe, expect, it } from 'vitest';
import { MetricsService } from './metrics.service.js';

describe('MetricsService', () => {
  it('exporta contadores e histograma HTTP em formato Prometheus', () => {
    const metrics = new MetricsService();
    metrics.recordHttpRequest('GET', '/health/live', 200, 0.02);
    metrics.recordHttpRequest('GET', '/health/live', 503, 0.5);
    metrics.recordHealthCheck('postgres', 'unavailable');

    const output = metrics.renderPrometheus();

    expect(output).toContain(
      'http_server_requests_total{method="GET",route="/health/live",status_code="200"} 1',
    );
    expect(output).toContain(
      'http_server_request_duration_seconds_bucket{method="GET",route="/health/live",status_code="200",le="0.025"} 1',
    );
    expect(output).toContain(
      'health_dependency_checks_total{dependency="postgres",status="unavailable"} 1',
    );
  });

  it('não exporta rota não normalizada nem método inválido como label', () => {
    const metrics = new MetricsService();
    metrics.recordHttpRequest('GET\nPOST', 'raw?token=value', 404, 0.01);

    const output = metrics.renderPrometheus();

    expect(output).toContain('method="OTHER",route="unmatched"');
    expect(output).not.toContain('token=value');
  });

  it('escapa valores de labels do formato Prometheus', () => {
    const metrics = new MetricsService();
    metrics.recordHealthCheck('queue"\\\nname', 'ok');

    expect(metrics.renderPrometheus()).toContain(
      'dependency="queue\\"\\\\\\nname"',
    );
  });

  it('exporta métricas de transação, retries, DLQ e conflitos de lock', () => {
    const metrics = new MetricsService();
    metrics.recordTransactionStatus('sqs', 'processed');
    metrics.recordTransactionStatus('http', 'rejected');
    metrics.recordDuplicateTransaction('sqs');
    metrics.recordRetry('pending_reference', 'scheduled');
    metrics.recordRetry('sqs', 'failed');
    metrics.recordDeadLetterQueueDepth('transactions', 3);
    metrics.recordLockConflict('transaction');

    const output = metrics.renderPrometheus();

    expect(output).toContain(
      '# HELP wager_transactions_total Transações financeiras observadas por origem e status.',
    );
    expect(output).toContain(
      'wager_transactions_total{source="sqs",status="processed"} 1',
    );
    expect(output).toContain(
      'wager_transactions_total{source="http",status="rejected"} 1',
    );
    expect(output).toContain(
      'wager_transaction_duplicates_total{source="sqs"} 1',
    );
    expect(output).toContain(
      'wager_retries_total{source="pending_reference",result="scheduled"} 1',
    );
    expect(output).toContain(
      'wager_retries_total{source="sqs",result="failed"} 1',
    );
    expect(output).toContain('# TYPE sqs_dead_letter_queue_messages gauge');
    expect(output).toContain(
      'sqs_dead_letter_queue_messages{queue="transactions"} 3',
    );
    expect(output).toContain(
      'database_lock_conflicts_total{lock_type="transaction"} 1',
    );
  });

  it('exporta durações de processamento e atraso da outbox em segundos', () => {
    const metrics = new MetricsService();
    metrics.recordTransactionProcessingDuration('sqs', 'processed', 0.02);
    metrics.recordOutboxPublishDelay(2);

    const output = metrics.renderPrometheus();

    expect(output).toContain(
      '# HELP wager_transaction_processing_duration_seconds Duração do processamento financeiro em segundos.',
    );
    expect(output).toContain(
      'wager_transaction_processing_duration_seconds_bucket{source="sqs",status="processed",le="0.025"} 1',
    );
    expect(output).toContain('outbox_publish_delay_seconds_bucket{le="2.5"} 1');
    expect(output).toContain('outbox_publish_delay_seconds_sum 2');
  });

  it('rejeita durações inválidas em vez de exportar medições incorretas', () => {
    const metrics = new MetricsService();

    expect(() => metrics.recordOutboxPublishDelay(Number.NaN)).toThrow(
      RangeError,
    );
    expect(() =>
      metrics.recordTransactionProcessingDuration('http', 'failed', -1),
    ).toThrow(RangeError);
  });

  it('rejeita profundidade de DLQ inválida', () => {
    const metrics = new MetricsService();

    expect(() => metrics.recordDeadLetterQueueDepth('events', -1)).toThrow(
      RangeError,
    );
  });

  it('exporta contadores de reconciliações consistentes e divergentes', () => {
    const metrics = new MetricsService();
    metrics.recordWalletReconciliation(true);
    metrics.recordWalletReconciliation(false);
    metrics.recordWalletReconciliation(false);

    expect(metrics.renderPrometheus()).toContain(
      'wallet_reconciliations_total{result="consistent"} 1',
    );
    expect(metrics.renderPrometheus()).toContain(
      'wallet_reconciliations_total{result="inconsistent"} 2',
    );
  });
});

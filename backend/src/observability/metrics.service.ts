import { Injectable } from '@nestjs/common';

const DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

interface HistogramGroup {
  name: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
  buckets: number[];
}

export type TransactionMetricSource = 'http' | 'sqs' | 'pending_reference';
export type TransactionMetricStatus =
  'pending_reference' | 'processed' | 'rejected' | 'failed';

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, MetricSample>();
  private readonly gauges = new Map<string, MetricSample>();
  private readonly durations = new Map<string, HistogramGroup>();

  recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ): void {
    const labels = {
      method: this.normalizeMethod(method),
      route: this.normalizeRoute(route),
      status_code: String(statusCode),
    };
    this.increment('http_server_requests_total', labels);
    this.observeDuration(
      'http_server_request_duration_seconds',
      labels,
      durationSeconds,
    );
  }

  recordHealthCheck(dependency: string, status: 'ok' | 'unavailable'): void {
    this.increment('health_dependency_checks_total', { dependency, status });
  }

  recordTransactionStatus(
    source: TransactionMetricSource,
    status: TransactionMetricStatus,
  ): void {
    this.increment('wager_transactions_total', { source, status });
  }

  recordDuplicateTransaction(source: 'http' | 'sqs'): void {
    this.increment('wager_transaction_duplicates_total', { source });
  }

  recordRetry(
    source: 'sqs' | 'pending_reference' | 'outbox',
    result: 'scheduled' | 'succeeded' | 'failed',
  ): void {
    this.increment('wager_retries_total', { source, result });
  }

  recordDeadLetterQueueDepth(
    queue: 'transactions' | 'events',
    depth: number,
  ): void {
    if (!Number.isSafeInteger(depth) || depth < 0) {
      throw new RangeError(
        'A profundidade da fila deve ser inteira e não negativa.',
      );
    }
    const labels = { queue };
    const name = 'sqs_dead_letter_queue_messages';
    this.gauges.set(this.key(name, labels), { name, labels, value: depth });
  }

  recordLockConflict(lockType: 'transaction' | 'outbox'): void {
    this.increment('database_lock_conflicts_total', { lock_type: lockType });
  }

  recordTransactionProcessingDuration(
    source: TransactionMetricSource,
    status: TransactionMetricStatus,
    durationSeconds: number,
  ): void {
    this.observeDuration(
      'wager_transaction_processing_duration_seconds',
      { source, status },
      durationSeconds,
    );
  }

  recordOutboxPublishDelay(delaySeconds: number): void {
    this.observeDuration('outbox_publish_delay_seconds', {}, delaySeconds);
  }

  renderPrometheus(): string {
    const lines = [
      '# HELP http_server_requests_total Total de requisições HTTP concluídas.',
      '# TYPE http_server_requests_total counter',
      ...this.renderCounters('http_server_requests_total'),
      '# HELP http_server_request_duration_seconds Duração das requisições HTTP em segundos.',
      '# TYPE http_server_request_duration_seconds histogram',
      ...this.renderHistograms('http_server_request_duration_seconds'),
      '# HELP health_dependency_checks_total Total de verificações de dependência do readiness.',
      '# TYPE health_dependency_checks_total counter',
      ...this.renderCounters('health_dependency_checks_total'),
      '# HELP wager_transactions_total Transações financeiras observadas por origem e status.',
      '# TYPE wager_transactions_total counter',
      ...this.renderCounters('wager_transactions_total'),
      '# HELP wager_transaction_duplicates_total Requisições de transação deduplicadas.',
      '# TYPE wager_transaction_duplicates_total counter',
      ...this.renderCounters('wager_transaction_duplicates_total'),
      '# HELP wager_retries_total Tentativas e agendamentos de retry por origem e resultado.',
      '# TYPE wager_retries_total counter',
      ...this.renderCounters('wager_retries_total'),
      '# HELP sqs_dead_letter_queue_messages Número aproximado de mensagens atualmente na dead-letter queue.',
      '# TYPE sqs_dead_letter_queue_messages gauge',
      ...this.renderGauges('sqs_dead_letter_queue_messages'),
      '# HELP database_lock_conflicts_total Conflitos de lock detectados por tipo.',
      '# TYPE database_lock_conflicts_total counter',
      ...this.renderCounters('database_lock_conflicts_total'),
      '# HELP wager_transaction_processing_duration_seconds Duração do processamento financeiro em segundos.',
      '# TYPE wager_transaction_processing_duration_seconds histogram',
      ...this.renderHistograms('wager_transaction_processing_duration_seconds'),
      '# HELP outbox_publish_delay_seconds Atraso entre criação do evento e publicação na outbox, em segundos.',
      '# TYPE outbox_publish_delay_seconds histogram',
      ...this.renderHistograms('outbox_publish_delay_seconds'),
    ];
    return `${lines.join('\n')}\n`;
  }

  private observeDuration(
    name: string,
    labels: Record<string, string>,
    durationSeconds: number,
  ): void {
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
      throw new RangeError(
        'A duração da métrica deve ser finita e não negativa.',
      );
    }
    const key = this.key(name, labels);
    const histogram = this.durations.get(key) ?? {
      name,
      labels,
      count: 0,
      sum: 0,
      buckets: DURATION_BUCKETS_SECONDS.map(() => 0),
    };
    histogram.count += 1;
    histogram.sum += durationSeconds;
    DURATION_BUCKETS_SECONDS.forEach((bucket, index) => {
      if (durationSeconds <= bucket) histogram.buckets[index] += 1;
    });
    this.durations.set(key, histogram);
  }

  private increment(name: string, labels: Record<string, string>): void {
    const key = this.key(name, labels);
    const sample = this.counters.get(key);
    if (sample) {
      sample.value += 1;
      return;
    }
    this.counters.set(key, { name, labels, value: 1 });
  }

  private renderCounters(name: string): string[] {
    return [...this.counters.values()]
      .filter((sample) => sample.name === name)
      .map((sample) =>
        this.renderSample(sample.name, sample.labels, sample.value),
      );
  }

  private renderGauges(name: string): string[] {
    return [...this.gauges.values()]
      .filter((sample) => sample.name === name)
      .map((sample) =>
        this.renderSample(sample.name, sample.labels, sample.value),
      );
  }

  private renderHistograms(name: string): string[] {
    const lines: string[] = [];
    for (const {
      name: groupName,
      labels,
      count,
      sum,
      buckets,
    } of this.durations.values()) {
      if (groupName !== name) continue;
      for (const [index, bucket] of DURATION_BUCKETS_SECONDS.entries()) {
        const bucketLabels = { ...labels, le: String(bucket) };
        lines.push(
          this.renderSample(`${name}_bucket`, bucketLabels, buckets[index]),
        );
      }
      lines.push(
        this.renderSample(`${name}_bucket`, { ...labels, le: '+Inf' }, count),
        this.renderSample(`${name}_sum`, labels, sum),
        this.renderSample(`${name}_count`, labels, count),
      );
    }
    return lines;
  }

  private renderSample(
    name: string,
    labels: Record<string, string>,
    value: number,
  ): string {
    if (Object.keys(labels).length === 0) return `${name} ${value}`;
    const serializedLabels = Object.entries(labels)
      .map(([key, label]) => `${key}="${this.escapeLabel(label)}"`)
      .join(',');
    return `${name}{${serializedLabels}} ${value}`;
  }

  private key(name: string, labels: Record<string, string>): string {
    return `${name}:${JSON.stringify(labels)}`;
  }

  private normalizeMethod(method: string): string {
    return /^[A-Z]+$/.test(method) ? method : 'OTHER';
  }

  private normalizeRoute(route: string): string {
    if (!route.startsWith('/') || route.length > 200) return 'unmatched';
    return route;
  }

  private escapeLabel(value: string): string {
    return value
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('\n', '\\n');
  }
}

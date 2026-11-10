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
  labels: Record<string, string>;
  count: number;
  sum: number;
  buckets: number[];
}

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, MetricSample>();
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
    const key = this.key('http_server_request_duration_seconds', labels);
    const histogram = this.durations.get(key) ?? {
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

  recordHealthCheck(dependency: string, status: 'ok' | 'unavailable'): void {
    this.increment('health_dependency_checks_total', { dependency, status });
  }

  recordWalletReconciliation(isConsistent: boolean): void {
    this.increment('wallet_reconciliations_total', {
      result: isConsistent ? 'consistent' : 'inconsistent',
    });
  }

  renderPrometheus(): string {
    const lines = [
      '# HELP http_server_requests_total Total de requisições HTTP concluídas.',
      '# TYPE http_server_requests_total counter',
      ...this.renderCounters('http_server_requests_total'),
      '# HELP http_server_request_duration_seconds Duração das requisições HTTP em segundos.',
      '# TYPE http_server_request_duration_seconds histogram',
      ...this.renderHistogram(),
      '# HELP health_dependency_checks_total Total de verificações de dependência do readiness.',
      '# TYPE health_dependency_checks_total counter',
      ...this.renderCounters('health_dependency_checks_total'),
      '# HELP wallet_reconciliations_total Total de reconciliações de saldo de wallets.',
      '# TYPE wallet_reconciliations_total counter',
      ...this.renderCounters('wallet_reconciliations_total'),
    ];
    return `${lines.join('\n')}\n`;
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

  private renderHistogram(): string[] {
    const lines: string[] = [];
    for (const { labels, count, sum, buckets } of this.durations.values()) {
      for (const [index, bucket] of DURATION_BUCKETS_SECONDS.entries()) {
        const bucketLabels = { ...labels, le: String(bucket) };
        lines.push(
          this.renderSample(
            'http_server_request_duration_seconds_bucket',
            bucketLabels,
            buckets[index],
          ),
        );
      }
      lines.push(
        this.renderSample(
          'http_server_request_duration_seconds_bucket',
          { ...labels, le: '+Inf' },
          count,
        ),
        this.renderSample(
          'http_server_request_duration_seconds_sum',
          labels,
          sum,
        ),
        this.renderSample(
          'http_server_request_duration_seconds_count',
          labels,
          count,
        ),
      );
    }
    return lines;
  }

  private renderSample(
    name: string,
    labels: Record<string, string>,
    value: number,
  ): string {
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

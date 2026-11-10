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
});

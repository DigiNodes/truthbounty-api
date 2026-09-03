import { Counter, Histogram, register } from 'prom-client';

export class MetricsService {
  private readonly requestCounter: Counter<string>;
  private readonly latencyHistogram: Histogram<string>;
  private totalRequests = 0;
  private errorCount = 0;
  private totalLatencyMs = 0;
  private latencySamples = 0;
  private readonly requestsByRoute = new Map<string, number>();
  private readonly statusCodes = new Map<string, number>();

  constructor() {
    this.requestCounter = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status'],
    });

    this.latencyHistogram = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.1, 0.3, 1.5, 10],
    });
  }

  incrementRequest(method: string, route: string, status: string) {
    this.requestCounter.inc({ method, route, status });
    this.totalRequests += 1;
    this.requestsByRoute.set(route, (this.requestsByRoute.get(route) || 0) + 1);
    this.statusCodes.set(status, (this.statusCodes.get(status) || 0) + 1);
    if (Number(status) >= 500) {
      this.errorCount += 1;
    }
  }

  observeLatency(method: string, route: string, status: string, duration: number) {
    this.latencyHistogram.observe({ method, route, status }, duration);
    this.totalLatencyMs += duration * 1000;
    this.latencySamples += 1;
  }

  async getMetrics() {
    return await register.metrics();
  }

  getSummary() {
    return {
      totalRequests: this.totalRequests,
      errorCount: this.errorCount,
      averageLatencyMs: this.latencySamples > 0 ? Math.round(this.totalLatencyMs / this.latencySamples) : 0,
      requestsByRoute: Object.fromEntries(this.requestsByRoute),
      statusCodes: Object.fromEntries(this.statusCodes),
    };
  }
}

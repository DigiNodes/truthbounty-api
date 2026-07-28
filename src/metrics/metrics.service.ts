import { Counter, Histogram, register } from "prom-client";

export class MetricsService {
  private readonly requestCounter: Counter<string>;
  private readonly latencyHistogram: Histogram<string>;

  constructor() {
    this.requestCounter = new Counter({
      name: "http_requests_total",
      help: "Total number of HTTP requests",
      labelNames: ["method", "route", "status"],
    });

    this.latencyHistogram = new Histogram({
      name: "http_request_duration_seconds",
      help: "Duration of HTTP requests in seconds",
      labelNames: ["method", "route", "status"],
      buckets: [0.1, 0.3, 1.5, 10],
    });
  }

  incrementRequest(method: string, route: string, status: string) {
    this.requestCounter.inc({ method, route, status });
  }

  observeLatency(method: string, route: string, status: string, duration: number) {
    this.latencyHistogram.observe({ method, route, status }, duration);
  }

  async getMetrics() {
    return await register.metrics();
  }
}

import * as client from "prom-client";

export class MetricsService {
  private readonly requestCounter: client.Counter<string>;
  private readonly latencyHistogram: client.Histogram<string>;

  constructor() {
    this.requestCounter = new client.Counter({
      name: "http_requests_total",
      help: "Total number of HTTP requests",
      labelNames: ["method", "route", "status"],
    });

    this.latencyHistogram = new client.Histogram({
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
    return await client.register.metrics();
  }
}

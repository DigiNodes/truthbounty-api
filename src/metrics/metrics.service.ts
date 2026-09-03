 feat/be-016-monitoring-api
import { Counter, Histogram, Gauge, register } from "prom-client";
import { Injectable } from "@nestjs/common";
import { Counter, Histogram, register } from 'prom-client';
 main

@Injectable()
export class MetricsService {
  private readonly requestCounter: Counter<string>;
  private readonly latencyHistogram: Histogram<string>;
  private totalRequests = 0;
  private errorCount = 0;
  private totalLatencyMs = 0;
  private latencySamples = 0;
  private readonly requestsByRoute = new Map<string, number>();
  private readonly statusCodes = new Map<string, number>();

  // Infrastructure metrics (BE-016): process-level resource usage, exposed
  // as scrapable Prometheus gauges rather than only appearing in the
  // /health JSON diagnostics payload.
  private readonly memoryUsageGauge: Gauge<string>;
  private readonly cpuUsageGauge: Gauge<string>;

  // Queue monitoring (BE-016): BullMQ job counts by state, so a stuck or
  // backed-up queue shows up in Prometheus/Grafana/Alertmanager before it
  // becomes a user-visible incident.
  private readonly queueDepthGauge: Gauge<string>;

  // Blockchain monitoring (BE-016): indexing lag in blocks, so chain-sync
  // degradation is alertable rather than only visible via a manual health
  // check call.
  private readonly blockchainLagGauge: Gauge<string>;
  private readonly blockchainLastIndexedBlockGauge: Gauge<string>;

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

    this.memoryUsageGauge = new Gauge({
      name: "process_memory_usage_bytes",
      help: "Node.js process memory usage in bytes, by memory type",
      labelNames: ["type"],
    });

    this.cpuUsageGauge = new Gauge({
      name: "process_cpu_usage_microseconds",
      help: "Node.js process CPU usage in microseconds, by mode",
      labelNames: ["mode"],
    });

    this.queueDepthGauge = new Gauge({
      name: "queue_jobs_total",
      help: "Number of jobs in a BullMQ queue, by queue name and job state",
      labelNames: ["queue", "state"],
    });

    this.blockchainLagGauge = new Gauge({
      name: "blockchain_indexing_lag_blocks",
      help: "Difference between the chain head and the last block processed by the indexer",
    });

    this.blockchainLastIndexedBlockGauge = new Gauge({
      name: "blockchain_last_indexed_block",
      help: "The most recent block number processed by the indexer",
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

  /**
   * Records current process memory usage as Prometheus gauges.
   * Call with the output of `process.memoryUsage()`.
   */
  setMemoryUsage(usage: { rss: number; heapTotal: number; heapUsed: number; external: number }): void {
    this.memoryUsageGauge.set({ type: "rss" }, usage.rss);
    this.memoryUsageGauge.set({ type: "heapTotal" }, usage.heapTotal);
    this.memoryUsageGauge.set({ type: "heapUsed" }, usage.heapUsed);
    this.memoryUsageGauge.set({ type: "external" }, usage.external);
  }

  /**
   * Records current process CPU usage as Prometheus gauges.
   * Call with the output of `process.cpuUsage()`.
   */
  setCpuUsage(usage: { user: number; system: number }): void {
    this.cpuUsageGauge.set({ mode: "user" }, usage.user);
    this.cpuUsageGauge.set({ mode: "system" }, usage.system);
  }

  /**
   * Records the current depth of a queue, broken down by job state
   * (waiting/active/completed/failed/delayed/paused). Call with the
   * output of BullMQ's `Queue.getJobCounts(...)`.
   */
  setQueueDepth(queueName: string, counts: Record<string, number>): void {
    for (const [state, count] of Object.entries(counts)) {
      this.queueDepthGauge.set({ queue: queueName, state }, count);
    }
  }

  /**
   * Records blockchain indexing lag. `chainHeadBlock` is optional since
   * not every RPC provider cheaply exposes the current chain head; when
   * omitted, only the last-indexed-block gauge is updated.
   */
  setBlockchainIndexingState(lastProcessedBlock: number, chainHeadBlock?: number): void {
    this.blockchainLastIndexedBlockGauge.set(lastProcessedBlock);
    if (typeof chainHeadBlock === "number") {
      this.blockchainLagGauge.set(Math.max(0, chainHeadBlock - lastProcessedBlock));
    }
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

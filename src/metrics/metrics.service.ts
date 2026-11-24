import { Counter, Histogram, Gauge, register } from 'prom-client';
import { Injectable } from '@nestjs/common';

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

  // Database pool monitoring (PREWAVE-BE-056): pool saturation, acquisition
  // timeouts, statement timeouts, and per-workload budget rejections. All
  // label sets are closed enums so metric cardinality stays bounded.
  private readonly dbPoolTotalGauge: Gauge<string>;
  private readonly dbPoolIdleGauge: Gauge<string>;
  private readonly dbPoolActiveGauge: Gauge<string>;
  private readonly dbPoolWaitingGauge: Gauge<string>;
  private readonly dbPoolAcquisitionTimeoutsCounter: Counter<string>;
  private readonly dbPoolStatementTimeoutsCounter: Counter<string>;
  private readonly dbPoolBudgetRejectedCounter: Counter<string>;

  // Lazily-registered domain counters (outbox, notifications, ...) so that
  // services can record business events without pre-declaring each metric.
  private readonly customCounters = new Map<string, Counter<string>>();

  // Lazily-registered labeled counters for cache health and other domain metrics
  private readonly labeledCounters = new Map<string, Counter<string>>();

  // Lazily-registered labeled gauges for cache health and other domain metrics
  private readonly labeledGauges = new Map<string, Gauge<string>>();

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
      name: 'process_memory_usage_bytes',
      help: 'Node.js process memory usage in bytes, by memory type',
      labelNames: ['type'],
    });

    this.cpuUsageGauge = new Gauge({
      name: 'process_cpu_usage_microseconds',
      help: 'Node.js process CPU usage in microseconds, by mode',
      labelNames: ['mode'],
    });

    this.queueDepthGauge = new Gauge({
      name: 'queue_jobs_total',
      help: 'Number of jobs in a BullMQ queue, by queue name and job state',
      labelNames: ['queue', 'state'],
    });

    this.blockchainLagGauge = new Gauge({
      name: 'blockchain_indexing_lag_blocks',
      help: 'Difference between the chain head and the last block processed by the indexer',
    });

    this.blockchainLastIndexedBlockGauge = new Gauge({
      name: 'blockchain_last_indexed_block',
      help: 'The most recent block number processed by the indexer',
    });

    this.dbPoolTotalGauge = new Gauge({
      name: 'db_pool_connections_total',
      help: 'Total connections currently established by the database pool',
    });

    this.dbPoolIdleGauge = new Gauge({
      name: 'db_pool_connections_idle',
      help: 'Idle (available) connections in the database pool',
    });

    this.dbPoolActiveGauge = new Gauge({
      name: 'db_pool_connections_active',
      help: 'Active (checked-out) connections in the database pool',
    });

    this.dbPoolWaitingGauge = new Gauge({
      name: 'db_pool_waiting',
      help: 'Callers currently waiting for a free database connection',
    });

    this.dbPoolAcquisitionTimeoutsCounter = new Counter({
      name: 'db_pool_acquisition_timeouts_total',
      help: 'Total database connection acquisitions that timed out',
      labelNames: ['workload'],
    });

    this.dbPoolStatementTimeoutsCounter = new Counter({
      name: 'db_pool_statement_timeouts_total',
      help: 'Total database statements cancelled by statement_timeout',
      labelNames: ['workload'],
    });

    this.dbPoolBudgetRejectedCounter = new Counter({
      name: 'db_pool_budget_rejected_total',
      help: 'Total database requests rejected because a workload budget was exhausted',
      labelNames: ['workload'],
    });
  }

  /**
   * Increment a named domain counter (created lazily on first use).
   * Used for business-level events such as outbox dispatches and
   * notification lifecycle transitions.
   * Overloaded to support labeled counters.
   */
  incrementCounter(
    name: string,
    labelsOrValue?: Record<string, string | number> | number,
    value = 1,
  ): void {
    // If second arg is a number, it's the value (unlabeled version)
    if (typeof labelsOrValue === 'number') {
      let counter = this.customCounters.get(name);
      if (!counter) {
        counter = new Counter({ name, help: name });
        this.customCounters.set(name, counter);
      }
      counter.inc(labelsOrValue);
      return;
    }

    // If second arg is an object, it's labels (labeled version)
    if (typeof labelsOrValue === 'object') {
      let counter = this.labeledCounters.get(name);
      if (!counter) {
        counter = new Counter({
          name,
          help: name,
          labelNames: Object.keys(labelsOrValue),
        });
        this.labeledCounters.set(name, counter);
      }
      counter.inc(labelsOrValue, value);
      return;
    }

    // Default unlabeled version
    let counter = this.customCounters.get(name);
    if (!counter) {
      counter = new Counter({ name, help: name });
      this.customCounters.set(name, counter);
    }
    counter.inc(value);
  }

  /**
   * Set a labeled gauge (created lazily on first use).
   * Used for metrics with labels such as cache health status, failure rates, etc.
   */
  setGauge(
    name: string,
    value: number,
    labels?: Record<string, string | number>,
  ): void {
    let gauge = this.labeledGauges.get(name);
    if (!gauge) {
      const labelNames = labels ? Object.keys(labels) : [];
      gauge = new Gauge({ name, help: name, labelNames });
      this.labeledGauges.set(name, gauge);
    }
    if (labels) {
      gauge.set(labels, value);
    } else {
      gauge.set(value);
    }
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

  observeLatency(
    method: string,
    route: string,
    status: string,
    duration: number,
  ) {
    this.latencyHistogram.observe({ method, route, status }, duration);
    this.totalLatencyMs += duration * 1000;
    this.latencySamples += 1;
  }

  /**
   * Records current process memory usage as Prometheus gauges.
   * Call with the output of `process.memoryUsage()`.
   */
  setMemoryUsage(usage: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  }): void {
    this.memoryUsageGauge.set({ type: 'rss' }, usage.rss);
    this.memoryUsageGauge.set({ type: 'heapTotal' }, usage.heapTotal);
    this.memoryUsageGauge.set({ type: 'heapUsed' }, usage.heapUsed);
    this.memoryUsageGauge.set({ type: 'external' }, usage.external);
  }

  /**
   * Records current process CPU usage as Prometheus gauges.
   * Call with the output of `process.cpuUsage()`.
   */
  setCpuUsage(usage: { user: number; system: number }): void {
    this.cpuUsageGauge.set({ mode: 'user' }, usage.user);
    this.cpuUsageGauge.set({ mode: 'system' }, usage.system);
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
  setBlockchainIndexingState(
    lastProcessedBlock: number,
    chainHeadBlock?: number,
  ): void {
    this.blockchainLastIndexedBlockGauge.set(lastProcessedBlock);
    if (typeof chainHeadBlock === 'number') {
      this.blockchainLagGauge.set(
        Math.max(0, chainHeadBlock - lastProcessedBlock),
      );
    }
  }

  /**
   * Records database pool utilization (PREWAVE-BE-056).
   *
   * Every value is clamped to a finite, non-negative integer before being
   * written, so a malformed driver reading can never push NaN or Infinity
   * into Prometheus. Callers should pass the output of
   * `DatabaseService.getBoundedPoolMetrics()`.
   */
  setDbPoolStats(stats: {
    total: number;
    idle: number;
    active: number;
    waiting: number;
  }): void {
    this.dbPoolTotalGauge.set(clampMetric(stats.total));
    this.dbPoolIdleGauge.set(clampMetric(stats.idle));
    this.dbPoolActiveGauge.set(clampMetric(stats.active));
    this.dbPoolWaitingGauge.set(clampMetric(stats.waiting));
  }

  /**
   * Increments the database connection-acquisition timeout counter.
   * `workload` must be one of the closed workload enum values; unknown
   * values are coerced to `default` so label cardinality stays bounded.
   */
  incrementDbAcquisitionTimeout(workload: string): void {
    this.dbPoolAcquisitionTimeoutsCounter.inc({
      workload: sanitizeWorkload(workload),
    });
  }

  /**
   * Increments the database statement-timeout counter (a statement was
   * cancelled by PostgreSQL's `statement_timeout`). `workload` is coerced
   * to the closed workload enum.
   */
  incrementDbStatementTimeout(workload: string): void {
    this.dbPoolStatementTimeoutsCounter.inc({
      workload: sanitizeWorkload(workload),
    });
  }

  /**
   * Increments the per-workload budget-rejection counter (a request was
   * refused because the workload's connection budget was exhausted).
   * `workload` is coerced to the closed workload enum.
   */
  incrementDbBudgetRejected(workload: string): void {
    this.dbPoolBudgetRejectedCounter.inc({
      workload: sanitizeWorkload(workload),
    });
  }

  async getMetrics() {
    return await register.metrics();
  }

  getSummary() {
    return {
      totalRequests: this.totalRequests,
      errorCount: this.errorCount,
      averageLatencyMs:
        this.latencySamples > 0
          ? Math.round(this.totalLatencyMs / this.latencySamples)
          : 0,
      requestsByRoute: Object.fromEntries(this.requestsByRoute),
      statusCodes: Object.fromEntries(this.statusCodes),
    };
  }
}

/**
 * Closed enum of workload names accepted as metric labels. Keeping this set
 * fixed guarantees `db_pool_*` metric cardinality cannot grow with
 * user-supplied input.
 */
const KNOWN_WORKLOADS = new Set(['api', 'jobs', 'admin', 'default']);

/**
 * Clamps a metric value to a finite, non-negative integer so NaN, Infinity,
 * or negative readings can never be written into Prometheus.
 */
function clampMetric(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Coerces an arbitrary workload string to the closed enum, defaulting to
 * `default` for unknown values (bounded label cardinality).
 */
function sanitizeWorkload(workload: string): string {
  const w = String(workload ?? '').toLowerCase();
  return KNOWN_WORKLOADS.has(w) ? w : 'default';
}

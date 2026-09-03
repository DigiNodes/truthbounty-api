import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { v4 as uuidv4 } from 'uuid';
import {
  Span,
  SpanCategory,
  SpanStatus,
  Trace,
  FlameGraphNode,
  LatencyDistribution,
  BottleneckReport,
  SamplingConfig,
  HistoricalSnapshot,
  RegressionReport,
  ComponentRegression,
  ResourceMetricsSample,
} from './interfaces/profiler.interface';

interface TraceContext {
  traceId: string;
  parentSpanId?: string;
}

@Injectable()
export class ProfilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProfilerService.name);
  private readonly asyncLocalStorage = new AsyncLocalStorage<TraceContext>();

  private traces: Trace[] = [];
  private snapshots: Map<string, HistoricalSnapshot> = new Map();
  private sampleTimer: NodeJS.Timeout | null = null;
  private recentResourceSamples: ResourceMetricsSample[] = [];

  private samplingConfig: SamplingConfig = {
    enabled: true,
    strategy: 'fixed-rate',
    defaultSampleRate: 1.0, // 100% by default in dev/test, adjustable
    slowQueryThresholdMs: 100,
    maxTracesInMemory: 5000,
    targetCpuThresholdPercent: 80,
    headerOverrideKey: 'x-profile-request',
    routeSampleRates: {},
  };

  onModuleInit() {
    this.logger.log('Initializing Performance Profiling Service...');
    // Periodic resource metric sampling every 10s
    this.sampleTimer = setInterval(() => {
      this.collectResourceSample();
    }, 10000);
    this.collectResourceSample();
  }

  onModuleDestroy() {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
    }
  }

  // --- SAMPLING LOGIC ---

  getSamplingConfig(): SamplingConfig {
    return { ...this.samplingConfig };
  }

  updateSamplingConfig(config: Partial<SamplingConfig>): SamplingConfig {
    this.samplingConfig = {
      ...this.samplingConfig,
      ...config,
    };
    this.logger.log(`Profiler sampling configuration updated: strategy=${this.samplingConfig.strategy}, rate=${this.samplingConfig.defaultSampleRate}`);
    return this.getSamplingConfig();
  }

  shouldSample(req?: any): boolean {
    if (!this.samplingConfig.enabled) {
      return false;
    }

    // 1. Header-based override check
    if (req && req.headers) {
      const headerVal = req.headers[this.samplingConfig.headerOverrideKey.toLowerCase()];
      if (headerVal === 'true' || headerVal === '1') {
        return true;
      }
      if (headerVal === 'false' || headerVal === '0') {
        return false;
      }
    }

    const route = req?.route?.path || req?.url;

    switch (this.samplingConfig.strategy) {
      case 'header-based':
        // Defaults to defaultSampleRate if header not provided
        return Math.random() < this.samplingConfig.defaultSampleRate;

      case 'route-based':
        if (route && this.samplingConfig.routeSampleRates?.[route] !== undefined) {
          return Math.random() < this.samplingConfig.routeSampleRates[route];
        }
        return Math.random() < this.samplingConfig.defaultSampleRate;

      case 'adaptive': {
        // Adjust sample rate based on CPU load
        const latestCpu = this.getLatestCpuPercent();
        let effectiveRate = this.samplingConfig.defaultSampleRate;
        if (latestCpu > this.samplingConfig.targetCpuThresholdPercent) {
          // Scale down sampling linearly when above target CPU threshold
          const cpuExceedRatio = (latestCpu - this.samplingConfig.targetCpuThresholdPercent) / 20;
          effectiveRate = Math.max(0.01, effectiveRate / (1 + cpuExceedRatio * 4));
        }
        return Math.random() < effectiveRate;
      }

      case 'fixed-rate':
      default:
        return Math.random() < this.samplingConfig.defaultSampleRate;
    }
  }

  isSlowQuery(durationMs: number): boolean {
    return durationMs >= this.samplingConfig.slowQueryThresholdMs;
  }

  // --- TRACE & SPAN LIFECYCLE ---

  startTrace(
    name: string,
    category: SpanCategory = 'http',
    metadata?: Record<string, any>,
  ): Trace {
    const traceId = uuidv4();
    const rootSpanId = uuidv4();
    const now = Date.now();
    const startHr = process.hrtime.bigint();

    const rootSpan: Span = {
      id: rootSpanId,
      traceId,
      name,
      category,
      startTimeHighRes: startHr,
      startTimeMs: now,
      status: 'ok',
      metadata,
    };

    const memoryBefore = process.memoryUsage().heapUsed;
    const cpuBefore = process.cpuUsage();

    const trace: Trace = {
      id: traceId,
      name,
      category,
      startTimeMs: now,
      durationMs: 0,
      rootSpan,
      spans: [rootSpan],
      slowQueryCount: 0,
      memoryDeltaMb: 0,
      cpuDeltaUs: { user: 0, system: 0 },
      timestamp: new Date().toISOString(),
      metadata: {
        memoryBefore,
        cpuBefore,
        ...metadata,
      },
      sampled: true,
    };

    // Store in circular trace buffer
    this.storeTrace(trace);

    // Set AsyncLocalStorage context
    this.asyncLocalStorage.enterWith({
      traceId,
      parentSpanId: rootSpanId,
    });

    return trace;
  }

  endTrace(traceId: string, metadata?: Record<string, any>): Trace | null {
    const trace = this.traces.find((t) => t.id === traceId);
    if (!trace) return null;

    const endTimeMs = Date.now();
    const durationMs = endTimeMs - trace.startTimeMs;

    trace.endTimeMs = endTimeMs;
    trace.durationMs = durationMs;
    trace.rootSpan.endTimeMs = endTimeMs;
    trace.rootSpan.durationMs = durationMs;

    if (metadata?.statusCode) trace.statusCode = metadata.statusCode;
    if (metadata?.route) trace.route = metadata.route;
    if (metadata?.method) trace.method = metadata.method;
    if (metadata?.status === 'error' || metadata?.errorMessage) {
      trace.rootSpan.status = 'error';
      trace.rootSpan.errorMessage = metadata.errorMessage || 'Error during execution';
    }

    // Calculate memory & CPU deltas
    const memoryAfter = process.memoryUsage().heapUsed;
    const memoryBefore = trace.metadata?.memoryBefore || memoryAfter;
    trace.memoryDeltaMb = Math.max(0, parseFloat(((memoryAfter - memoryBefore) / (1024 * 1024)).toFixed(3)));

    const cpuBefore = trace.metadata?.cpuBefore;
    if (cpuBefore) {
      const cpuAfter = process.cpuUsage(cpuBefore);
      trace.cpuDeltaUs = {
        user: cpuAfter.user,
        system: cpuAfter.system,
      };
    }

    // Count slow queries inside trace
    trace.slowQueryCount = trace.spans.filter(
      (s) => s.category === 'db' && s.durationMs && s.durationMs >= this.samplingConfig.slowQueryThresholdMs,
    ).length;

    if (metadata) {
      trace.metadata = { ...trace.metadata, ...metadata };
    }

    return trace;
  }

  startSpan(
    name: string,
    category: SpanCategory,
    parentSpanId?: string,
    metadata?: Record<string, any>,
  ): Span {
    const store = this.asyncLocalStorage.getStore();
    const traceId = store?.traceId || uuidv4();
    const resolvedParentSpanId = parentSpanId || store?.parentSpanId;

    const span: Span = {
      id: uuidv4(),
      traceId,
      parentSpanId: resolvedParentSpanId,
      name,
      category,
      startTimeHighRes: process.hrtime.bigint(),
      startTimeMs: Date.now(),
      status: 'ok',
      metadata,
    };

    const trace = this.traces.find((t) => t.id === traceId);
    if (trace) {
      trace.spans.push(span);
    }

    return span;
  }

  endSpan(spanId: string, status: SpanStatus = 'ok', metadata?: Record<string, any>): Span | null {
    for (const trace of this.traces) {
      const span = trace.spans.find((s) => s.id === spanId);
      if (span) {
        const endTimeMs = Date.now();
        span.endTimeMs = endTimeMs;
        span.durationMs = metadata?.durationMs !== undefined ? metadata.durationMs : Math.max(0, endTimeMs - span.startTimeMs);
        span.status = status;
        if (metadata?.errorMessage) span.errorMessage = metadata.errorMessage;
        if (metadata) {
          span.metadata = { ...span.metadata, ...metadata };
        }
        return span;
      }
    }
    return null;
  }

  // --- QUERY & METRICS RETRIEVAL ---

  getTraces(filter?: {
    route?: string;
    method?: string;
    category?: SpanCategory;
    minDurationMs?: number;
    hasSlowQueries?: boolean;
    limit?: number;
  }): Trace[] {
    let result = [...this.traces];

    if (filter?.route) {
      result = result.filter((t) => t.route?.toLowerCase().includes(filter.route!.toLowerCase()));
    }
    if (filter?.method) {
      result = result.filter((t) => t.method?.toUpperCase() === filter.method!.toUpperCase());
    }
    if (filter?.category) {
      result = result.filter((t) => t.category === filter.category);
    }
    if (filter?.minDurationMs !== undefined) {
      result = result.filter((t) => t.durationMs >= filter.minDurationMs!);
    }
    if (filter?.hasSlowQueries) {
      result = result.filter((t) => t.slowQueryCount > 0);
    }

    result.sort((a, b) => b.startTimeMs - a.startTimeMs);
    const limit = filter?.limit || 100;
    return result.slice(0, limit);
  }

  getTraceById(id: string): Trace | null {
    return this.traces.find((t) => t.id === id) || null;
  }

  getSummary(): Record<string, any> {
    const totalTraces = this.traces.length;
    const completedTraces = this.traces.filter((t) => t.durationMs > 0);
    const totalDuration = completedTraces.reduce((sum, t) => sum + t.durationMs, 0);
    const avgDurationMs = completedTraces.length ? totalDuration / completedTraces.length : 0;
    const errorCount = completedTraces.filter((t) => t.rootSpan.status === 'error' || (t.statusCode && t.statusCode >= 400)).length;
    const slowQueryTracesCount = completedTraces.filter((t) => t.slowQueryCount > 0).length;

    return {
      service: 'TruthBounty Profiling Service',
      version: '1.0.0',
      status: 'active',
      samplingConfig: this.getSamplingConfig(),
      metrics: {
        totalTraces,
        completedTraces: completedTraces.length,
        avgDurationMs: parseFloat(avgDurationMs.toFixed(2)),
        errorCount,
        errorRate: completedTraces.length ? parseFloat((errorCount / completedTraces.length).toFixed(4)) : 0,
        slowQueryTracesCount,
        totalSnapshots: this.snapshots.size,
      },
      latestResourceSample: this.recentResourceSamples[this.recentResourceSamples.length - 1] || null,
    };
  }

  getLatencyDistributions(filter?: { route?: string; category?: SpanCategory }): LatencyDistribution {
    let dataset = this.traces.filter((t) => t.durationMs > 0);

    if (filter?.route) {
      dataset = dataset.filter((t) => t.route === filter.route);
    }
    if (filter?.category) {
      dataset = dataset.filter((t) => t.category === filter.category);
    }

    if (dataset.length === 0) {
      return {
        p50: 0,
        p75: 0,
        p90: 0,
        p95: 0,
        p99: 0,
        mean: 0,
        min: 0,
        max: 0,
        totalCount: 0,
        slowQueryCount: 0,
        errorRate: 0,
      };
    }

    const durations = dataset.map((t) => t.durationMs).sort((a, b) => a - b);
    const totalCount = durations.length;
    const sum = durations.reduce((acc, v) => acc + v, 0);
    const errorCount = dataset.filter((t) => t.rootSpan.status === 'error' || (t.statusCode && t.statusCode >= 400)).length;
    const slowQueryCount = dataset.reduce((acc, t) => acc + t.slowQueryCount, 0);

    const percentile = (p: number) => {
      const idx = Math.ceil((p / 100) * totalCount) - 1;
      return durations[Math.max(0, Math.min(idx, totalCount - 1))];
    };

    return {
      p50: percentile(50),
      p75: percentile(75),
      p90: percentile(90),
      p95: percentile(95),
      p99: percentile(99),
      mean: parseFloat((sum / totalCount).toFixed(2)),
      min: durations[0],
      max: durations[totalCount - 1],
      totalCount,
      slowQueryCount,
      errorRate: parseFloat((errorCount / totalCount).toFixed(4)),
    };
  }

  // --- FLAME GRAPH BUILDING ---

  generateFlameGraph(traceId: string): FlameGraphNode | null {
    const trace = this.getTraceById(traceId);
    if (!trace) return null;

    const totalDurationMs = Math.max(1, trace.durationMs || 1);

    // Map spans by ID for hierarchy lookup
    const spanMap = new Map<string, FlameGraphNode>();

    for (const span of trace.spans) {
      const durationMs = span.durationMs || 0;
      spanMap.set(span.id, {
        name: span.name,
        value: durationMs,
        durationMs,
        category: span.category,
        children: [],
        percentage: parseFloat(((durationMs / totalDurationMs) * 100).toFixed(2)),
        metadata: span.metadata,
      });
    }

    let rootNode: FlameGraphNode | null = null;

    for (const span of trace.spans) {
      const node = spanMap.get(span.id)!;
      if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
        const parentNode = spanMap.get(span.parentSpanId)!;
        parentNode.children.push(node);
      } else if (!rootNode || span.id === trace.rootSpan.id) {
        rootNode = node;
      }
    }

    return rootNode || spanMap.get(trace.rootSpan.id) || null;
  }

  // --- BOTTLENECK REPORT ---

  generateBottleneckReport(): BottleneckReport {
    const completedTraces = this.traces.filter((t) => t.durationMs > 0);

    // 1. Slow endpoints
    const endpointGroup = new Map<string, { route: string; method: string; durations: number[]; errors: number }>();
    for (const t of completedTraces) {
      const key = `${t.method || 'GET'}:${t.route || t.name}`;
      if (!endpointGroup.has(key)) {
        endpointGroup.set(key, {
          route: t.route || t.name,
          method: t.method || 'GET',
          durations: [],
          errors: 0,
        });
      }
      const item = endpointGroup.get(key)!;
      item.durations.push(t.durationMs);
      if (t.rootSpan.status === 'error' || (t.statusCode && t.statusCode >= 400)) {
        item.errors++;
      }
    }

    const slowEndpoints = Array.from(endpointGroup.values())
      .map((e) => {
        const sorted = e.durations.sort((a, b) => a - b);
        const avg = sorted.reduce((sum, d) => sum + d, 0) / sorted.length;
        const p95Idx = Math.ceil(0.95 * sorted.length) - 1;
        const p95 = sorted[Math.max(0, p95Idx)];
        return {
          route: e.route,
          method: e.method,
          avgDurationMs: parseFloat(avg.toFixed(2)),
          p95DurationMs: p95,
          count: sorted.length,
          errorCount: e.errors,
        };
      })
      .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
      .slice(0, 10);

    // 2. Slow DB queries
    const queryGroup = new Map<string, { query: string; entity?: string; durations: number[] }>();
    // 3. Slow Redis ops
    const redisGroup = new Map<string, { command: string; keyPattern?: string; durations: number[] }>();
    // 4. Slow RPC calls
    const rpcGroup = new Map<string, { method: string; durations: number[] }>();
    // 5. Slow Queue jobs
    const jobGroup = new Map<string, { jobName: string; queueName: string; durations: number[] }>();
    // 6. Slow Notifications
    const notifGroup = new Map<string, { type: string; target?: string; durations: number[] }>();
    // 7. CPU Hotspots
    const categoryTimeMap = new Map<SpanCategory, number>();

    for (const t of completedTraces) {
      for (const s of t.spans) {
        const duration = s.durationMs || 0;

        // CPU Hotspot categorization
        const currentTime = categoryTimeMap.get(s.category) || 0;
        categoryTimeMap.set(s.category, currentTime + duration);

        if (s.category === 'db') {
          const q = s.metadata?.query || s.name;
          const entity = s.metadata?.entity;
          if (!queryGroup.has(q)) {
            queryGroup.set(q, { query: q, entity, durations: [] });
          }
          queryGroup.get(q)!.durations.push(duration);
        } else if (s.category === 'redis') {
          const cmd = s.metadata?.command || s.name;
          const kp = s.metadata?.keyPattern;
          if (!redisGroup.has(cmd)) {
            redisGroup.set(cmd, { command: cmd, keyPattern: kp, durations: [] });
          }
          redisGroup.get(cmd)!.durations.push(duration);
        } else if (s.category === 'blockchain') {
          const m = s.metadata?.method || s.name;
          if (!rpcGroup.has(m)) {
            rpcGroup.set(m, { method: m, durations: [] });
          }
          rpcGroup.get(m)!.durations.push(duration);
        } else if (s.category === 'queue') {
          const job = s.metadata?.jobName || s.name;
          const qName = s.metadata?.queueName || 'default';
          if (!jobGroup.has(job)) {
            jobGroup.set(job, { jobName: job, queueName: qName, durations: [] });
          }
          jobGroup.get(job)!.durations.push(duration);
        } else if (s.category === 'notification') {
          const nType = s.metadata?.type || s.name;
          const tgt = s.metadata?.target;
          if (!notifGroup.has(nType)) {
            notifGroup.set(nType, { type: nType, target: tgt, durations: [] });
          }
          notifGroup.get(nType)!.durations.push(duration);
        }
      }
    }

    const slowQueries = Array.from(queryGroup.values())
      .map((q) => {
        const sorted = q.durations.sort((a, b) => a - b);
        const avg = sorted.reduce((sum, d) => sum + d, 0) / sorted.length;
        return {
          query: q.query,
          entity: q.entity,
          avgDurationMs: parseFloat(avg.toFixed(2)),
          maxDurationMs: sorted[sorted.length - 1],
          executionCount: sorted.length,
        };
      })
      .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
      .slice(0, 10);

    const slowRedisOps = Array.from(redisGroup.values())
      .map((r) => {
        const sorted = r.durations.sort((a, b) => a - b);
        const avg = sorted.reduce((sum, d) => sum + d, 0) / sorted.length;
        return {
          command: r.command,
          keyPattern: r.keyPattern,
          avgDurationMs: parseFloat(avg.toFixed(2)),
          count: sorted.length,
        };
      })
      .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
      .slice(0, 10);

    const slowBlockchainCalls = Array.from(rpcGroup.values())
      .map((b) => {
        const sorted = b.durations.sort((a, b) => a - b);
        const avg = sorted.reduce((sum, d) => sum + d, 0) / sorted.length;
        return {
          method: b.method,
          avgDurationMs: parseFloat(avg.toFixed(2)),
          count: sorted.length,
        };
      })
      .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
      .slice(0, 10);

    const slowQueueJobs = Array.from(jobGroup.values())
      .map((j) => {
        const sorted = j.durations.sort((a, b) => a - b);
        const avg = sorted.reduce((sum, d) => sum + d, 0) / sorted.length;
        return {
          jobName: j.jobName,
          queueName: j.queueName,
          avgDurationMs: parseFloat(avg.toFixed(2)),
          count: sorted.length,
        };
      })
      .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
      .slice(0, 10);

    const slowNotifications = Array.from(notifGroup.values())
      .map((n) => {
        const sorted = n.durations.sort((a, b) => a - b);
        const avg = sorted.reduce((sum, d) => sum + d, 0) / sorted.length;
        return {
          type: n.type,
          target: n.target,
          avgDurationMs: parseFloat(avg.toFixed(2)),
          count: sorted.length,
        };
      })
      .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
      .slice(0, 10);

    const totalCategoryTime = Array.from(categoryTimeMap.values()).reduce((sum, v) => sum + v, 0) || 1;
    const cpuHotspots = Array.from(categoryTimeMap.entries())
      .map(([cat, timeSpentMs]) => ({
        category: cat,
        timeSpentMs: parseFloat(timeSpentMs.toFixed(2)),
        percentage: parseFloat(((timeSpentMs / totalCategoryTime) * 100).toFixed(2)),
      }))
      .sort((a, b) => b.timeSpentMs - a.timeSpentMs);

    return {
      slowEndpoints,
      slowQueries,
      slowRedisOps,
      slowBlockchainCalls,
      slowQueueJobs,
      slowNotifications,
      cpuHotspots,
      generatedAt: new Date().toISOString(),
    };
  }

  // --- HISTORICAL COMPARISONS & REGRESSION DETECTION ---

  takeHistoricalSnapshot(name: string): HistoricalSnapshot {
    const id = uuidv4();
    const now = new Date().toISOString();
    const completedTraces = this.traces.filter((t) => t.durationMs > 0);

    const windowStart = completedTraces.length ? completedTraces[completedTraces.length - 1].timestamp : now;
    const windowEnd = completedTraces.length ? completedTraces[0].timestamp : now;

    const latencyDistribution = this.getLatencyDistributions();

    // Endpoint metrics rollup
    const endpointMetrics: Record<string, { avgDurationMs: number; p95DurationMs: number; count: number; errorCount: number }> = {};
    for (const ep of this.generateBottleneckReport().slowEndpoints) {
      endpointMetrics[`${ep.method}:${ep.route}`] = {
        avgDurationMs: ep.avgDurationMs,
        p95DurationMs: ep.p95DurationMs,
        count: ep.count,
        errorCount: ep.errorCount,
      };
    }

    // Query metrics rollup
    const queryMetrics: Record<string, { avgDurationMs: number; maxDurationMs: number; count: number }> = {};
    for (const q of this.generateBottleneckReport().slowQueries) {
      queryMetrics[q.query] = {
        avgDurationMs: q.avgDurationMs,
        maxDurationMs: q.maxDurationMs,
        count: q.executionCount,
      };
    }

    // Resource metrics rollup
    const memoryUsage = process.memoryUsage();
    const resourceMetrics = {
      avgHeapUsedMb: parseFloat((memoryUsage.heapUsed / (1024 * 1024)).toFixed(2)),
      maxHeapUsedMb: parseFloat((memoryUsage.heapTotal / (1024 * 1024)).toFixed(2)),
      avgCpuUserMs: 0,
      avgCpuSystemMs: 0,
    };

    const snapshot: HistoricalSnapshot = {
      id,
      name,
      createdAt: now,
      windowStart,
      windowEnd,
      traceCount: completedTraces.length,
      latencyDistribution,
      endpointMetrics,
      queryMetrics,
      resourceMetrics,
    };

    this.snapshots.set(id, snapshot);
    this.logger.log(`Historical profile snapshot created: ${id} (${name})`);
    return snapshot;
  }

  getHistoricalSnapshots(): HistoricalSnapshot[] {
    return Array.from(this.snapshots.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  compareHistorical(baselineId: string, targetId: string): Record<string, any> | null {
    const baseline = this.snapshots.get(baselineId);
    const target = this.snapshots.get(targetId);

    if (!baseline || !target) return null;

    const latencyDelta = {
      p50: parseFloat((target.latencyDistribution.p50 - baseline.latencyDistribution.p50).toFixed(2)),
      p95: parseFloat((target.latencyDistribution.p95 - baseline.latencyDistribution.p95).toFixed(2)),
      p99: parseFloat((target.latencyDistribution.p99 - baseline.latencyDistribution.p99).toFixed(2)),
      mean: parseFloat((target.latencyDistribution.mean - baseline.latencyDistribution.mean).toFixed(2)),
    };

    const memoryDeltaMb = parseFloat((target.resourceMetrics.avgHeapUsedMb - baseline.resourceMetrics.avgHeapUsedMb).toFixed(2));

    return {
      baseline: { id: baseline.id, name: baseline.name, createdAt: baseline.createdAt },
      target: { id: target.id, name: target.name, createdAt: target.createdAt },
      latencyDelta,
      memoryDeltaMb,
      baselineMetrics: baseline.latencyDistribution,
      targetMetrics: target.latencyDistribution,
    };
  }

  detectRegressions(baselineId: string, targetId: string, thresholdPercent: number = 20): RegressionReport {
    const baseline = this.snapshots.get(baselineId);
    const target = this.snapshots.get(targetId);

    const regressions: ComponentRegression[] = [];

    if (!baseline || !target) {
      return {
        generatedAt: new Date().toISOString(),
        status: 'no_regressions',
        baselineSnapshotId: baselineId,
        targetSnapshotId: targetId,
        regressions: [],
        summary: { totalEvaluated: 0, regressionsFound: 0, maxDegradationPercent: 0 },
      };
    }

    let totalEvaluated = 0;
    let maxDegradationPercent = 0;

    // Evaluate overall latency
    totalEvaluated++;
    const latencyBase = baseline.latencyDistribution.p95 || 1;
    const latencyCurr = target.latencyDistribution.p95 || 1;
    const latencyChangePercent = parseFloat((((latencyCurr - latencyBase) / latencyBase) * 100).toFixed(2));

    if (latencyChangePercent >= thresholdPercent) {
      maxDegradationPercent = Math.max(maxDegradationPercent, latencyChangePercent);
      regressions.push({
        component: 'System Latency',
        metricName: 'p95LatencyMs',
        baselineValue: latencyBase,
        currentValue: latencyCurr,
        percentChange: latencyChangePercent,
        severity: latencyChangePercent > 50 ? 'critical' : 'high',
        description: `Overall p95 latency increased by ${latencyChangePercent}% (${latencyBase}ms -> ${latencyCurr}ms)`,
      });
    }

    // Evaluate endpoints
    for (const [epKey, epCurr] of Object.entries(target.endpointMetrics)) {
      totalEvaluated++;
      const epBase = baseline.endpointMetrics[epKey];
      if (epBase) {
        const epBaseAvg = epBase.avgDurationMs || 1;
        const epCurrAvg = epCurr.avgDurationMs || 1;
        const changePct = parseFloat((((epCurrAvg - epBaseAvg) / epBaseAvg) * 100).toFixed(2));

        if (changePct >= thresholdPercent) {
          maxDegradationPercent = Math.max(maxDegradationPercent, changePct);
          regressions.push({
            component: `Endpoint:${epKey}`,
            metricName: 'avgDurationMs',
            baselineValue: epBaseAvg,
            currentValue: epCurrAvg,
            percentChange: changePct,
            severity: changePct > 100 ? 'critical' : changePct > 50 ? 'high' : 'medium',
            description: `Endpoint ${epKey} average latency increased by ${changePct}% (${epBaseAvg}ms -> ${epCurrAvg}ms)`,
          });
        }
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      status: regressions.length > 0 ? 'regressions_detected' : 'no_regressions',
      baselineSnapshotId: baselineId,
      targetSnapshotId: targetId,
      regressions,
      summary: {
        totalEvaluated,
        regressionsFound: regressions.length,
        maxDegradationPercent,
      },
    };
  }

  // --- PRIVATE UTILS & RESOURCE METRICS ---

  private storeTrace(trace: Trace) {
    this.traces.push(trace);
    if (this.traces.length > this.samplingConfig.maxTracesInMemory) {
      this.traces.shift(); // remove oldest trace
    }
  }

  private collectResourceSample() {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();

    const sample: ResourceMetricsSample = {
      timestamp: new Date().toISOString(),
      memory: {
        rssMb: parseFloat((memory.rss / (1024 * 1024)).toFixed(2)),
        heapTotalMb: parseFloat((memory.heapTotal / (1024 * 1024)).toFixed(2)),
        heapUsedMb: parseFloat((memory.heapUsed / (1024 * 1024)).toFixed(2)),
        externalMb: parseFloat((memory.external / (1024 * 1024)).toFixed(2)),
        arrayBuffersMb: parseFloat(((memory.arrayBuffers || 0) / (1024 * 1024)).toFixed(2)),
      },
      cpu: {
        userTimeUs: cpu.user,
        systemTimeUs: cpu.system,
        cpuPercent: this.calculateCpuPercent(cpu),
      },
    };

    this.recentResourceSamples.push(sample);
    if (this.recentResourceSamples.length > 100) {
      this.recentResourceSamples.shift();
    }
  }

  private getLatestCpuPercent(): number {
    if (this.recentResourceSamples.length === 0) return 10;
    return this.recentResourceSamples[this.recentResourceSamples.length - 1].cpu.cpuPercent;
  }

  private calculateCpuPercent(cpu: NodeJS.CpuUsage): number {
    const totalUs = cpu.user + cpu.system;
    // Approximated CPU percent for simple heuristic
    return Math.min(100, parseFloat(((totalUs / 1000000) * 10).toFixed(1)));
  }
}

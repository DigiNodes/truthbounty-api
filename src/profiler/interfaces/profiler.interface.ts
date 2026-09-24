export type SpanCategory =
  | 'http'
  | 'db'
  | 'redis'
  | 'blockchain'
  | 'queue'
  | 'notification'
  | 'system';

export type SpanStatus = 'ok' | 'error';

export interface Span {
  id: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  category: SpanCategory;
  startTimeHighRes: bigint;
  startTimeMs: number;
  endTimeMs?: number;
  durationMs?: number;
  status: SpanStatus;
  metadata?: Record<string, any>;
  errorMessage?: string;
}

export interface Trace {
  id: string;
  name: string;
  category: SpanCategory;
  route?: string;
  method?: string;
  statusCode?: number;
  startTimeMs: number;
  endTimeMs?: number;
  durationMs: number;
  rootSpan: Span;
  spans: Span[];
  slowQueryCount: number;
  memoryDeltaMb: number;
  cpuDeltaUs: { user: number; system: number };
  timestamp: string;
  metadata?: Record<string, any>;
  sampled: boolean;
}

export interface FlameGraphNode {
  name: string;
  value: number; // total duration in ms
  durationMs: number;
  category: SpanCategory;
  children: FlameGraphNode[];
  percentage: number;
  metadata?: Record<string, any>;
}

export interface LatencyDistribution {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  totalCount: number;
  slowQueryCount: number;
  errorRate: number;
}

export interface BottleneckReport {
  slowEndpoints: Array<{
    route: string;
    method: string;
    avgDurationMs: number;
    p95DurationMs: number;
    count: number;
    errorCount: number;
  }>;
  slowQueries: Array<{
    query: string;
    entity?: string;
    avgDurationMs: number;
    maxDurationMs: number;
    executionCount: number;
  }>;
  slowRedisOps: Array<{
    command: string;
    keyPattern?: string;
    avgDurationMs: number;
    count: number;
  }>;
  slowBlockchainCalls: Array<{
    method: string;
    avgDurationMs: number;
    count: number;
  }>;
  slowQueueJobs: Array<{
    jobName: string;
    queueName: string;
    avgDurationMs: number;
    count: number;
  }>;
  slowNotifications: Array<{
    type: string;
    target?: string;
    avgDurationMs: number;
    count: number;
  }>;
  cpuHotspots: Array<{
    category: SpanCategory;
    timeSpentMs: number;
    percentage: number;
  }>;
  generatedAt: string;
}

export type SamplingStrategy =
  | 'fixed-rate'
  | 'adaptive'
  | 'header-based'
  | 'route-based';

export interface SamplingConfig {
  enabled: boolean;
  strategy: SamplingStrategy;
  defaultSampleRate: number; // e.g. 0.1 for 10%
  slowQueryThresholdMs: number; // default 100ms
  maxTracesInMemory: number; // default 5000
  targetCpuThresholdPercent: number; // for adaptive sampling, e.g. 80%
  headerOverrideKey: string; // e.g. 'x-profile-request'
  routeSampleRates?: Record<string, number>;
}

export interface HistoricalSnapshot {
  id: string;
  name: string;
  createdAt: string;
  windowStart: string;
  windowEnd: string;
  traceCount: number;
  latencyDistribution: LatencyDistribution;
  endpointMetrics: Record<
    string,
    {
      avgDurationMs: number;
      p95DurationMs: number;
      count: number;
      errorCount: number;
    }
  >;
  queryMetrics: Record<
    string,
    {
      avgDurationMs: number;
      maxDurationMs: number;
      count: number;
    }
  >;
  resourceMetrics: {
    avgHeapUsedMb: number;
    maxHeapUsedMb: number;
    avgCpuUserMs: number;
    avgCpuSystemMs: number;
  };
}

export interface ComponentRegression {
  component: string;
  metricName: string;
  baselineValue: number;
  currentValue: number;
  percentChange: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
}

export interface RegressionReport {
  generatedAt: string;
  status: 'no_regressions' | 'regressions_detected';
  baselineSnapshotId: string;
  targetSnapshotId: string;
  regressions: ComponentRegression[];
  summary: {
    totalEvaluated: number;
    regressionsFound: number;
    maxDegradationPercent: number;
  };
}

export interface ResourceMetricsSample {
  timestamp: string;
  memory: {
    rssMb: number;
    heapTotalMb: number;
    heapUsedMb: number;
    externalMb: number;
    arrayBuffersMb: number;
  };
  cpu: {
    userTimeUs: number;
    systemTimeUs: number;
    cpuPercent: number;
  };
}

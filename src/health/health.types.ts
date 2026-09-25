export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface IndexerHealthResult {
  status: HealthStatus;
  timestamp: string;
  snapshot: import('../blockchain/types').IndexerHealthSnapshot;
}

export type FailureReasonCode =
  | 'TIMEOUT'
  | 'CONNECTION_ERROR'
  | 'THRESHOLD_EXCEEDED'
  | 'UNAVAILABLE'
  | 'UNKNOWN';

export interface DependencyStatus {
  name: string;
  status: HealthStatus;
  critical: boolean;
  /** Wall-clock time the probe actually took, measured against a bounded timeout. */
  responseTimeMs: number;
  lastSuccessfulCheck?: string;
  failureReason?: string;
  failureReasonCode?: FailureReasonCode;
}

export interface HealthSummary {
  healthy: number;
  degraded: number;
  unhealthy: number;
  total: number;
}

export interface HealthCheckResult {
  status: HealthStatus;
  timestamp: string;
  checkedAt: string;
  version: string;
  uptime: number;
  environment: string;
  summary: HealthSummary;
  services: Record<string, HealthStatus>;
  dependencies: DependencyStatus[];
  diagnostics?: SystemDiagnostics;
}

export interface LivenessResult {
  status: 'alive';
  timestamp: string;
  uptime: number;
}

export interface ReadinessResult {
  status: HealthStatus;
  timestamp: string;
  ready: boolean;
  /** When the underlying dependency checks were actually measured (may predate `timestamp` if served from cache). */
  checkedAt: string;
  dependencies: DependencyStatus[];
}

export interface StartupResult {
  status: HealthStatus;
  timestamp: string;
  checkedAt: string;
  ready: boolean;
  startupComplete: boolean;
  dependencies: DependencyStatus[];
}

export interface DependencyHealthResult {
  status: HealthStatus;
  timestamp: string;
  checkedAt: string;
  dependencies: DependencyStatus[];
}

export interface SystemDiagnostics {
  memoryUsage: NodeJS.MemoryUsage;
  cpuUsage: NodeJS.CpuUsage;
  resourceUsage?: NodeJS.ResourceUsage;
  eventLoopDelayMs?: number;
  openFileDescriptors?: number;
  database?: {
    connectivity: boolean;
    latencyMs: number;
    migrationsApplied: number;
    migrationsPending: number;
    poolTotal: number;
    poolIdle: number;
    poolActive: number;
    poolWaiting: number;
  };
}

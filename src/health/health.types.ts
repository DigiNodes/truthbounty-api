export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface DependencyStatus {
  name: string;
  status: HealthStatus;
  responseTimeMs: number;
  lastSuccessfulCheck?: string;
  failureReason?: string;
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
  dependencies: DependencyStatus[];
}

export interface StartupResult {
  status: HealthStatus;
  timestamp: string;
  ready: boolean;
  startupComplete: boolean;
  dependencies: DependencyStatus[];
}

export interface DependencyHealthResult {
  status: HealthStatus;
  timestamp: string;
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

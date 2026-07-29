export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface DependencyStatus {
  name: string;
  status: HealthStatus;
  responseTimeMs: number;
  lastSuccessfulCheck?: string;
  failureReason?: string;
}

export interface HealthCheckResult {
  status: HealthStatus;
  timestamp: string;
  version: string;
  uptime: number;
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

export interface SystemDiagnostics {
  memoryUsage: NodeJS.MemoryUsage;
  cpuUsage: NodeJS.CpuUsage;
  eventLoopDelayMs?: number;
  activeConnections?: number;
}

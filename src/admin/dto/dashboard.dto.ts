import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class HealthStatusDto {
  @ApiProperty()
  status: string;

  @ApiProperty()
  uptime: number;

  @ApiProperty()
  timestamp: string;

  @ApiProperty()
  database: string;

  @ApiPropertyOptional()
  redis: string;

  @ApiPropertyOptional()
  queues: string;
}

export class DashboardOverviewDto {
  @ApiProperty()
  totalAdmins: number;

  @ApiProperty()
  activeModerators: number;

  @ApiProperty()
  pendingReports: number;

  @ApiProperty()
  openIncidents: number;

  @ApiProperty()
  criticalIncidents: number;

  @ApiProperty()
  resolvedToday: number;

  @ApiProperty()
  avgResponseTimeHours: number;

  @ApiProperty()
  moderationBacklog: number;
}

export class ModerationStatsDto {
  @ApiProperty()
  total: number;

  @ApiProperty()
  pending: number;

  @ApiProperty()
  underReview: number;

  @ApiProperty()
  resolved: number;

  @ApiProperty()
  dismissed: number;

  @ApiProperty()
  byType: Record<string, number>;

  @ApiProperty()
  byPriority: Record<string, number>;

  @ApiProperty()
  avgResolutionTimeHours: number;
}

export class IncidentStatsDto {
  @ApiProperty()
  total: number;

  @ApiProperty()
  open: number;

  @ApiProperty()
  investigating: number;

  @ApiProperty()
  resolved: number;

  @ApiProperty()
  closed: number;

  @ApiProperty()
  bySeverity: Record<string, number>;

  @ApiProperty()
  byClassification: Record<string, number>;

  @ApiProperty()
  avgResolutionTimeHours: number;
}

export class MonitoringMetricsDto {
  @ApiProperty()
  activeAdmins: number;

  @ApiProperty()
  incidentsOpened24h: number;

  @ApiProperty()
  incidentsResolved24h: number;

  @ApiProperty()
  moderationBacklog: number;

  @ApiProperty()
  avgResponseTimeHours: number;

  @ApiProperty()
  securityAlerts: number;

  @ApiProperty()
  apiLatencyMs: number;

  @ApiProperty()
  reportsLast24h: number;

  @ApiProperty()
  timestamp: string;
}

export class OperationalDashboardDto {
  @ApiProperty()
  system: Record<string, any>;

  @ApiProperty()
  admin: Record<string, any>;

  @ApiProperty()
  infrastructure: Record<string, any>;

  @ApiProperty()
  api: Record<string, any>;

  @ApiProperty()
  notifications: Record<string, any>;

  @ApiProperty()
  jobs: Record<string, any>;

  @ApiProperty()
  protocol: Record<string, any>;
}

export class InfrastructureHealthDto {
  @ApiProperty()
  status: string;

  @ApiProperty()
  timestamp: string;

  @ApiProperty()
  database: Record<string, any>;

  @ApiProperty()
  redis: Record<string, any>;

  @ApiProperty()
  queues: Record<string, any>;

  @ApiProperty()
  workers: Record<string, any>;
}

export class QueueMetricsDto {
  @ApiProperty()
  status: string;

  @ApiProperty()
  totalQueues: number;

  @ApiProperty()
  totalWaiting: number;

  @ApiProperty()
  totalActive: number;

  @ApiProperty()
  totalFailed: number;

  @ApiProperty()
  totalCompleted: number;

  @ApiProperty()
  totalDelayed: number;
}

export class WorkerStatusDto {
  @ApiProperty()
  status: string;

  @ApiProperty()
  activeWorkers: number;

  @ApiProperty()
  totalWorkers: number;

  @ApiProperty()
  queueDepth: number;
}

export class ApiMetricsDto {
  @ApiProperty()
  totalRequests: number;

  @ApiProperty()
  errorCount: number;

  @ApiProperty()
  averageLatencyMs: number;

  @ApiProperty()
  statusCodes: Record<string, number>;

  @ApiProperty()
  requestsByRoute: Record<string, number>;
}

export class CacheStatisticsDto {
  @ApiProperty()
  status: string;

  @ApiProperty()
  connected: boolean;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty()
  queueDepth: number;
}

export class DatabaseMetricsDto {
  @ApiProperty()
  status: string;

  @ApiProperty()
  totalAdmins: number;

  @ApiProperty()
  totalClaims: number;

  @ApiProperty()
  totalIncidents: number;

  @ApiProperty()
  totalReports: number;

  @ApiProperty()
  timestamp: string;
}

export class NotificationMetricsDto {
  @ApiProperty()
  queued: number;

  @ApiProperty()
  delivered: number;

  @ApiProperty()
  failed: number;

  @ApiProperty()
  queueDepth: number;

  @ApiProperty()
  webhooks: Record<string, any>;
}

export class WebhookMetricsDto {
  @ApiProperty()
  total: number;

  @ApiProperty()
  delivered: number;

  @ApiProperty()
  pending: number;

  @ApiProperty()
  failed: number;
}

export class BackgroundJobsDto {
  @ApiProperty()
  totalQueues: number;

  @ApiProperty()
  failedJobs: number;

  @ApiProperty()
  queues: Record<string, any>[];
}

export class ProtocolActivityDto {
  @ApiProperty()
  totalClaims: number;

  @ApiProperty()
  activeClaims: number;

  @ApiProperty()
  finalizedClaims: number;

  @ApiProperty()
  pendingClaims: number;

  @ApiProperty()
  resolvedClaims: number;
}

export class PaginatedResponseDto<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };

  constructor(data: T[], total: number, page: number, limit: number) {
    this.data = data;
    this.pagination = {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }
}

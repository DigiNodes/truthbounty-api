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
  blockchain: string;
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

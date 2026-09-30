import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { DashboardService } from './dashboard.service';
import { AdminGuard } from '../guards/admin.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { AdminRole } from '../entities/admin.entity';

import {
  DashboardOverviewDto,
  HealthStatusDto,
  OperationalDashboardDto,
  InfrastructureHealthDto,
  QueueMetricsDto,
  WorkerStatusDto,
  ApiMetricsDto,
  CacheStatisticsDto,
  DatabaseMetricsDto,
  NotificationMetricsDto,
  WebhookMetricsDto,
  BackgroundJobsDto,
  ProtocolActivityDto,
} from '../dto/dashboard.dto';

/**
 * Roles allowed to access operational dashboard metrics.
 *
 * Kept in one place to avoid repeating the same role list
 * across every endpoint.
 */
const DASHBOARD_ROLES = [
  AdminRole.SUPER_ADMIN,
  AdminRole.ADMINISTRATOR,
  AdminRole.AUDITOR,
  AdminRole.SECURITY_ANALYST,
] as const;

const MODERATION_ROLES = [
  AdminRole.SUPER_ADMIN,
  AdminRole.ADMINISTRATOR,
  AdminRole.MODERATOR,
  AdminRole.AUDITOR,
] as const;

const AUDIT_ROLES = [
  AdminRole.SUPER_ADMIN,
  AdminRole.ADMINISTRATOR,
  AdminRole.AUDITOR,
] as const;

@ApiTags('admin / dashboard')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  description: 'Authentication is required.',
})
@ApiForbiddenResponse({
  description: 'The authenticated administrator does not have permission.',
})
@Controller('admin/dashboard')
@UseGuards(AdminGuard, RolesGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @Roles(...DASHBOARD_ROLES)
  @ApiOperation({
    summary: 'Get dashboard overview',
    description:
      'Returns the primary administrative dashboard metrics and system summary.',
  })
  @ApiResponse({
    status: 200,
    description: 'Dashboard overview retrieved successfully.',
    type: DashboardOverviewDto,
  })
  async getOverview(): Promise<DashboardOverviewDto> {
    return this.dashboardService.getOverview();
  }

  @Get('health')
  @Roles(...DASHBOARD_ROLES)
  @ApiOperation({
    summary: 'Get protocol health',
    description:
      'Returns the current health state of the protocol and its critical services.',
  })
  @ApiResponse({
    status: 200,
    description: 'Protocol health retrieved successfully.',
    type: HealthStatusDto,
  })
  async getHealth(): Promise<HealthStatusDto> {
    return this.dashboardService.getHealth();
  }

  @Get('operational-summary')
  @Roles(...DASHBOARD_ROLES)
  @ApiOperation({
    summary: 'Get operational dashboard summary',
    description:
      'Returns an aggregated view of operational infrastructure, queues, workers, APIs, and system services.',
  })
  @ApiResponse({
    status: 200,
    description: 'Operational dashboard retrieved successfully.',
    type: OperationalDashboardDto,
  })
  async getOperationalSummary(): Promise<OperationalDashboardDto> {
    return this.dashboardService.getOperationalSummary();
  }

  @Get('infrastructure')
  @Roles(...DASHBOARD_ROLES)
  @ApiOperation({
    summary: 'Get infrastructure health',
    description: 'Returns infrastructure health information and queue status.',
  })
  @ApiResponse({
    status: 200,
    description: 'Infrastructure health retrieved successfully.',
    type: InfrastructureHealthDto,
  })
  async getInfrastructureHealth(): Promise<InfrastructureHealthDto> {
    return this.dashboardService.getInfrastructureHealth();
  }

  @Get('queues')
  @Roles(...DASHBOARD_ROLES)
  @ApiOperation({
    summary: 'Get queue statistics',
    description:
      'Returns queue depth, processing, failure, and related background-worker metrics.',
  })
  @ApiResponse({
    status: 200,
    description: 'Queue metrics retrieved successfully.',
    type: QueueMetricsDto,
  })
  async getQueueStatistics(): Promise<QueueMetricsDto> {
    return this.dashboardService.getQueueStatistics();
  }

  @Get('workers')
  @Roles(...DASHBOARD_ROLES)
  @ApiOperation({
    summary: 'Get worker status',
    description:
      'Returns worker health, availability, and utilisation information.',
  })
  @ApiResponse({
    status: 200,
    description: 'Worker status retrieved successfully.',
    type: WorkerStatusDto,
  })
  async getWorkerStatus(): Promise<WorkerStatusDto> {
    return this.dashboardService.getWorkerStatus();
  }

  @Get('api-metrics')
  @Roles(...DASHBOARD_ROLES)
  @ApiOperation({
    summary: 'Get API metrics',
    description:
      'Returns API traffic, latency, error-rate, and request metrics.',
  })
  @ApiResponse({
    status: 200,
    description: 'API metrics retrieved successfully.',
    type: ApiMetricsDto,
  })
  async getApiMetrics(): Promise<ApiMetricsDto> {
    return this.dashboardService.getApiMetrics();
  }

  @Get('cache')
  @Roles(...DASHBOARD_ROLES)
  @ApiOperation({
    summary: 'Get cache statistics',
    description:
      'Returns Redis/cache health, hit rate, misses, and related statistics.',
  })
  @ApiResponse({
    status: 200,
    description: 'Cache statistics retrieved successfully.',
    type: CacheStatisticsDto,
  })
  async getCacheStatistics(): Promise<CacheStatisticsDto> {
    return this.dashboardService.getCacheStatistics();
  }

  @Get('database')
  @Roles(...DASHBOARD_ROLES)
  @ApiOperation({
    summary: 'Get database metrics',
    description:
      'Returns database health, connection, performance, and table statistics.',
  })
  @ApiResponse({
    status: 200,
    description: 'Database metrics retrieved successfully.',
    type: DatabaseMetricsDto,
  })
  async getDatabaseMetrics(): Promise<DatabaseMetricsDto> {
    return this.dashboardService.getDatabaseMetrics();
  }

  @Get('notifications')
  @Roles(...DASHBOARD_ROLES)
  @ApiOperation({
    summary: 'Get notification metrics',
    description:
      'Returns notification queue, processing, delivery, and failure metrics.',
  })
  @ApiResponse({
    status: 200,
    description: 'Notification metrics retrieved successfully.',
    type: NotificationMetricsDto,
  })
  async getNotificationMetrics(): Promise<NotificationMetricsDto> {
    return this.dashboardService.getNotificationMetrics();
  }

  @Get('webhooks')
  @Roles(...DASHBOARD_ROLES)
  @ApiOperation({
    summary: 'Get webhook metrics',
    description:
      'Returns webhook delivery, failure, retry, and processing metrics.',
  })
  @ApiResponse({
    status: 200,
    description: 'Webhook metrics retrieved successfully.',
    type: WebhookMetricsDto,
  })
  async getWebhookMetrics(): Promise<WebhookMetricsDto> {
    return this.dashboardService.getWebhookMetrics();
  }

  @Get('jobs')
  @Roles(...DASHBOARD_ROLES)
  @ApiOperation({
    summary: 'Get background job metrics',
    description: 'Returns background job queue and processing statistics.',
  })
  @ApiResponse({
    status: 200,
    description: 'Background job metrics retrieved successfully.',
    type: BackgroundJobsDto,
  })
  async getBackgroundJobs(): Promise<BackgroundJobsDto> {
    return this.dashboardService.getBackgroundJobs();
  }

  @Get('protocol')
  @Roles(...DASHBOARD_ROLES)
  @ApiOperation({
    summary: 'Get protocol activity',
    description:
      'Returns aggregated protocol activity and transaction metrics.',
  })
  @ApiResponse({
    status: 200,
    description: 'Protocol activity retrieved successfully.',
    type: ProtocolActivityDto,
  })
  async getProtocolActivity(): Promise<ProtocolActivityDto> {
    return this.dashboardService.getProtocolActivity();
  }

  @Get('moderation')
  @Roles(...MODERATION_ROLES)
  @ApiOperation({
    summary: 'Get moderation statistics',
    description:
      'Returns administrative moderation workload and activity metrics.',
  })
  @ApiResponse({
    status: 200,
    description: 'Moderation statistics retrieved successfully.',
    type: DashboardOverviewDto,
  })
  async getModerationStats(): Promise<DashboardOverviewDto> {
    return this.dashboardService.getOverview();
  }

  @Get('incidents')
  @Roles(
    AdminRole.SUPER_ADMIN,
    AdminRole.ADMINISTRATOR,
    AdminRole.SECURITY_ANALYST,
    AdminRole.AUDITOR,
  )
  @ApiOperation({
    summary: 'Get incident statistics',
    description:
      'Returns administrative incident and security-related statistics.',
  })
  @ApiResponse({
    status: 200,
    description: 'Incident statistics retrieved successfully.',
    type: DashboardOverviewDto,
  })
  async getIncidentStats(): Promise<DashboardOverviewDto> {
    return this.dashboardService.getOverview();
  }

  @Get('audit')
  @Roles(...AUDIT_ROLES)
  @ApiOperation({
    summary: 'Get audit summary',
    description: 'Returns audit activity for the requested number of days.',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    example: 7,
    description: 'Number of previous days to include in the audit summary.',
  })
  @ApiResponse({
    status: 200,
    description: 'Audit summary retrieved successfully.',
  })
  async getAuditSummary(@Query('days') days?: string) {
    const parsedDays = days === undefined ? 7 : Number(days);

    if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 365) {
      throw new Error('days must be an integer between 1 and 365');
    }

    return this.dashboardService.getAuditSummary(parsedDays);
  }

  @Get('monitoring')
  @Roles(...DASHBOARD_ROLES)
  @ApiOperation({
    summary: 'Get monitoring metrics',
    description:
      'Returns current monitoring and real-time operational metrics.',
  })
  @ApiResponse({
    status: 200,
    description: 'Monitoring metrics retrieved successfully.',
  })
  async getMonitoring() {
    return this.dashboardService.getMonitoring();
  }
}

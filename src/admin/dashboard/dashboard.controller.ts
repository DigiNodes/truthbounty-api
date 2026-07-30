import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
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

@ApiTags('admin / dashboard')
@ApiBearerAuth()
@Controller('admin/dashboard')
@UseGuards(AdminGuard, RolesGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'Get main dashboard overview' })
  @ApiResponse({ status: 200, description: 'Dashboard overview data', type: DashboardOverviewDto })
  async getOverview() {
    return this.dashboardService.getOverview();
  }

  @Get('health')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.SECURITY_ANALYST, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'Get protocol health status' })
  @ApiResponse({ status: 200, description: 'System health summary', type: HealthStatusDto })
  async getHealth() {
    return this.dashboardService.getHealth();
  }

  @Get('operational-summary')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.AUDITOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Get aggregated operational dashboard summary' })
  @ApiResponse({ status: 200, description: 'Aggregated operational dashboard data', type: OperationalDashboardDto })
  async getOperationalSummary() {
    return this.dashboardService.getOperationalSummary();
  }

  @Get('infrastructure')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.AUDITOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Get infrastructure health and queue status' })
  @ApiResponse({ status: 200, description: 'Infrastructure health summary', type: InfrastructureHealthDto })
  async getInfrastructureHealth() {
    return this.dashboardService.getInfrastructureHealth();
  }

  @Get('queues')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.AUDITOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Get queue statistics across background workers' })
  @ApiResponse({ status: 200, description: 'Queue metrics', type: QueueMetricsDto })
  async getQueueStatistics() {
    return this.dashboardService.getQueueStatistics();
  }

  @Get('workers')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.AUDITOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Get worker health and utilisation' })
  @ApiResponse({ status: 200, description: 'Worker status summary', type: WorkerStatusDto })
  async getWorkerStatus() {
    return this.dashboardService.getWorkerStatus();
  }

  @Get('api-metrics')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.AUDITOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Get API traffic and latency metrics' })
  @ApiResponse({ status: 200, description: 'API metrics summary', type: ApiMetricsDto })
  async getApiMetrics() {
    return this.dashboardService.getApiMetrics();
  }

  @Get('cache')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.AUDITOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Get cache and Redis status' })
  @ApiResponse({ status: 200, description: 'Cache summary', type: CacheStatisticsDto })
  async getCacheStatistics() {
    return this.dashboardService.getCacheStatistics();
  }

  @Get('database')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.AUDITOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Get database health and table statistics' })
  @ApiResponse({ status: 200, description: 'Database metrics', type: DatabaseMetricsDto })
  async getDatabaseMetrics() {
    return this.dashboardService.getDatabaseMetrics();
  }

  @Get('notifications')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.AUDITOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Get notification queue and delivery metrics' })
  @ApiResponse({ status: 200, description: 'Notification metrics', type: NotificationMetricsDto })
  async getNotificationMetrics() {
    return this.dashboardService.getNotificationMetrics();
  }

  @Get('webhooks')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.AUDITOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Get webhook delivery metrics' })
  @ApiResponse({ status: 200, description: 'Webhook metrics', type: WebhookMetricsDto })
  async getWebhookMetrics() {
    return this.dashboardService.getWebhookMetrics();
  }

  @Get('jobs')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.AUDITOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Get background job queue overview' })
  @ApiResponse({ status: 200, description: 'Background job overview', type: BackgroundJobsDto })
  async getBackgroundJobs() {
    return this.dashboardService.getBackgroundJobs();
  }

  @Get('protocol')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.AUDITOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Get protocol activity summary' })
  @ApiResponse({ status: 200, description: 'Protocol activity summary', type: ProtocolActivityDto })
  async getProtocolActivity() {
    return this.dashboardService.getProtocolActivity();
  }

  @Get('moderation')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.MODERATOR, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'Get moderation workload statistics' })
  async getModerationStats() {
    return this.dashboardService.getOverview();
  }

  @Get('incidents')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.SECURITY_ANALYST, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'Get incident statistics' })
  async getIncidentStats() {
    return this.dashboardService.getOverview();
  }

  @Get('audit')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'Get audit summary' })
  @ApiQuery({ name: 'days', required: false, description: 'Number of days' })
  async getAuditSummary(@Query('days') days?: string) {
    return this.dashboardService.getAuditSummary(days ? parseInt(days, 10) : 7);
  }

  @Get('monitoring')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.SECURITY_ANALYST, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'Get real-time monitoring metrics' })
  async getMonitoring() {
    return this.dashboardService.getMonitoring();
  }
}

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { AdminGuard } from '../guards/admin.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { AdminRole } from '../entities/admin.entity';

@ApiTags('admin / dashboard')
@ApiBearerAuth()
@Controller('admin/dashboard')
@UseGuards(AdminGuard, RolesGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'Get main dashboard overview' })
  @ApiResponse({ status: 200, description: 'Dashboard overview data' })
  async getOverview() {
    return this.dashboardService.getOverview();
  }

  @Get('health')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.SECURITY_ANALYST, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'Get protocol health status' })
  async getHealth() {
    return this.dashboardService.getHealth();
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

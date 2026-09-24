import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminGuard } from '../guards/admin.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { CurrentAdmin } from '../decorators/current-admin.decorator';
import { Admin, AdminRole } from '../entities/admin.entity';
import { ProtocolAdminService } from './protocol-admin.service';
import {
  ExecuteEmergencyActionDto,
  EmergencyActionResponse,
  SystemStatusResponse,
} from './dto/emergency.dto';
import {
  SetMaintenanceModeDto,
  ScheduleMaintenanceDto,
  MaintenanceStatusResponse,
} from './dto/maintenance.dto';
import {
  ControlServiceDto,
  ServiceControlResponse,
  AllQueueMetricsResponse,
} from './dto/service-control.dto';
import { ProtocolConfigDto, OperationalStatsResponse } from './dto/config.dto';

@ApiTags('Protocol Administration')
@ApiBearerAuth()
@UseGuards(AdminGuard, RolesGuard)
@Controller('admin/protocol')
export class ProtocolAdminController {
  constructor(
    private readonly protocolAdminService: ProtocolAdminService,
  ) {}

  // ──────────────────────────────────────────────
  //  SYSTEM STATUS
  // ──────────────────────────────────────────────

  @Get('status')
  @Roles(
    AdminRole.SUPER_ADMIN,
    AdminRole.ADMINISTRATOR,
    AdminRole.SECURITY_ANALYST,
    AdminRole.AUDITOR,
  )
  @ApiOperation({ summary: 'Get overall system status' })
  @ApiResponse({
    status: 200,
    description: 'System status',
    type: SystemStatusResponse,
  })
  async getSystemStatus(): Promise<SystemStatusResponse> {
    return this.protocolAdminService.getSystemStatus();
  }

  @Get('stats')
  @Roles(
    AdminRole.SUPER_ADMIN,
    AdminRole.ADMINISTRATOR,
    AdminRole.SECURITY_ANALYST,
    AdminRole.AUDITOR,
  )
  @ApiOperation({ summary: 'Get operational statistics' })
  @ApiResponse({
    status: 200,
    description: 'Operational statistics',
    type: OperationalStatsResponse,
  })
  async getOperationalStats(): Promise<OperationalStatsResponse> {
    return this.protocolAdminService.getOperationalStats();
  }

  @Get('stats/detailed')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Get detailed operational statistics' })
  async getDetailedStats(): Promise<Record<string, unknown>> {
    return this.protocolAdminService.getDetailedOperationalStats();
  }

  // ──────────────────────────────────────────────
  //  MAINTENANCE
  // ──────────────────────────────────────────────

  @Get('maintenance')
  @Roles(
    AdminRole.SUPER_ADMIN,
    AdminRole.ADMINISTRATOR,
    AdminRole.SECURITY_ANALYST,
    AdminRole.AUDITOR,
  )
  @ApiOperation({ summary: 'Get maintenance mode status' })
  @ApiResponse({
    status: 200,
    description: 'Maintenance status',
    type: MaintenanceStatusResponse,
  })
  async getMaintenanceStatus(): Promise<MaintenanceStatusResponse> {
    return this.protocolAdminService.getMaintenanceStatus();
  }

  @Post('maintenance')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Enable or disable maintenance mode' })
  @ApiResponse({
    status: 200,
    description: 'Maintenance mode updated',
    type: MaintenanceStatusResponse,
  })
  async setMaintenanceMode(
    @Body() dto: SetMaintenanceModeDto,
    @CurrentAdmin() admin: Admin,
  ): Promise<MaintenanceStatusResponse> {
    return this.protocolAdminService.setMaintenanceMode(dto, admin.id);
  }

  @Post('maintenance/schedule')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Schedule maintenance' })
  @ApiResponse({ status: 201, description: 'Maintenance scheduled' })
  async scheduleMaintenance(
    @Body() dto: ScheduleMaintenanceDto,
    @CurrentAdmin() admin: Admin,
  ) {
    return this.protocolAdminService.scheduleMaintenance(dto, admin.id);
  }

  @Delete('maintenance/schedule/:scheduleId')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Cancel scheduled maintenance' })
  @ApiParam({ name: 'scheduleId', description: 'Maintenance schedule ID' })
  @ApiResponse({ status: 200, description: 'Maintenance cancelled' })
  async cancelMaintenance(
    @Param('scheduleId') scheduleId: string,
    @CurrentAdmin() admin: Admin,
  ): Promise<void> {
    return this.protocolAdminService.cancelMaintenance(scheduleId, admin.id);
  }

  // ──────────────────────────────────────────────
  //  SERVICE MANAGEMENT
  // ──────────────────────────────────────────────

  @Post('services/control')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Control a service (pause/resume/suspend/etc.)' })
  @ApiResponse({
    status: 200,
    description: 'Service control executed',
    type: ServiceControlResponse,
  })
  async controlService(
    @Body() dto: ControlServiceDto,
    @CurrentAdmin() admin: Admin,
  ): Promise<ServiceControlResponse> {
    return this.protocolAdminService.controlService(dto, admin.id);
  }

  @Get('queues')
  @Roles(
    AdminRole.SUPER_ADMIN,
    AdminRole.ADMINISTRATOR,
    AdminRole.SECURITY_ANALYST,
    AdminRole.AUDITOR,
  )
  @ApiOperation({ summary: 'Get queue metrics for all queues' })
  @ApiResponse({
    status: 200,
    description: 'Queue metrics',
    type: AllQueueMetricsResponse,
  })
  async getQueueMetrics(): Promise<AllQueueMetricsResponse> {
    return this.protocolAdminService.getQueueMetrics();
  }

  @Post('queues/retry-failed')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Retry all failed jobs' })
  @ApiQuery({
    name: 'queueName',
    required: false,
    description: 'Specific queue name (optional)',
  })
  async retryFailedJobs(
    @Query('queueName') queueName?: string,
    @CurrentAdmin() admin?: Admin,
  ): Promise<{ retried: number }> {
    return this.protocolAdminService.retryFailedJobs(
      queueName,
      admin?.id,
    );
  }

  // ──────────────────────────────────────────────
  //  EMERGENCY OPERATIONS
  // ──────────────────────────────────────────────

  @Post('emergency')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Execute an emergency operational action' })
  @ApiResponse({
    status: 200,
    description: 'Emergency action executed',
    type: EmergencyActionResponse,
  })
  async executeEmergencyAction(
    @Body() dto: ExecuteEmergencyActionDto,
    @CurrentAdmin() admin: Admin,
  ): Promise<EmergencyActionResponse> {
    return this.protocolAdminService.executeEmergencyAction(dto, admin.id);
  }

  @Post('emergency/:action/resolve')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Resolve an active emergency action' })
  @ApiParam({
    name: 'action',
    description: 'Emergency action to resolve',
  })
  @ApiResponse({ status: 200, description: 'Emergency action resolved' })
  async resolveEmergencyAction(
    @Param('action') action: string,
    @CurrentAdmin() admin: Admin,
  ): Promise<void> {
    return this.protocolAdminService.resolveEmergencyAction(
      action as any,
      admin.id,
    );
  }

  // ──────────────────────────────────────────────
  //  CONFIGURATION
  // ──────────────────────────────────────────────

  @Get('config')
  @Roles(
    AdminRole.SUPER_ADMIN,
    AdminRole.ADMINISTRATOR,
    AdminRole.SECURITY_ANALYST,
    AdminRole.AUDITOR,
  )
  @ApiOperation({ summary: 'List all protocol configuration values' })
  @ApiQuery({
    name: 'environment',
    required: false,
    description: 'Environment scope',
  })
  async listConfig(
    @Query('environment') environment?: string,
  ) {
    return this.protocolAdminService.listAllConfig(environment);
  }

  @Get('config/:key')
  @Roles(
    AdminRole.SUPER_ADMIN,
    AdminRole.ADMINISTRATOR,
    AdminRole.SECURITY_ANALYST,
    AdminRole.AUDITOR,
  )
  @ApiOperation({ summary: 'Get a specific protocol configuration' })
  @ApiParam({ name: 'key', description: 'Configuration key' })
  async getConfig(
    @Param('key') key: string,
    @Query('environment') environment?: string,
  ): Promise<{ key: string; value: unknown } | null> {
    return this.protocolAdminService.getProtocolConfig(key, environment);
  }

  @Post('config')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Set a protocol configuration value' })
  @ApiResponse({ status: 201, description: 'Configuration updated' })
  async setConfig(
    @Body() dto: ProtocolConfigDto,
    @CurrentAdmin() admin: Admin,
  ) {
    return this.protocolAdminService.setProtocolConfig(dto, admin.id);
  }

  // ──────────────────────────────────────────────
  //  FEATURE FLAGS
  // ──────────────────────────────────────────────

  @Get('feature-flags')
  @Roles(
    AdminRole.SUPER_ADMIN,
    AdminRole.ADMINISTRATOR,
    AdminRole.SECURITY_ANALYST,
    AdminRole.AUDITOR,
  )
  @ApiOperation({ summary: 'List all feature flags' })
  @ApiQuery({
    name: 'environment',
    required: false,
    description: 'Environment scope',
  })
  async listFeatureFlags(
    @Query('environment') environment?: string,
  ) {
    return this.protocolAdminService.listFeatureFlags(environment);
  }

  @Get('feature-flags/evaluate/:key')
  @Roles(
    AdminRole.SUPER_ADMIN,
    AdminRole.ADMINISTRATOR,
    AdminRole.SECURITY_ANALYST,
    AdminRole.AUDITOR,
  )
  @ApiOperation({ summary: 'Evaluate a feature flag for a given context' })
  async evaluateFeatureFlag(
    @Param('key') key: string,
    @Query('userId') userId?: string,
    @Query('roles') roles?: string,
    @Query('environment') environment?: string,
  ) {
    const context: Record<string, unknown> = {};
    if (userId) context.userId = userId;
    if (roles) context.roles = roles.split(',');
    if (environment) context.environment = environment;
    return this.protocolAdminService.evaluateFeatureFlag(key, context);
  }

  // ──────────────────────────────────────────────
  //  AUDIT
  // ──────────────────────────────────────────────

  @Get('audit-logs')
  @Roles(
    AdminRole.SUPER_ADMIN,
    AdminRole.ADMINISTRATOR,
    AdminRole.AUDITOR,
    AdminRole.SECURITY_ANALYST,
  )
  @ApiOperation({ summary: 'Get protocol administration audit logs' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Number of logs (default 50)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'Pagination offset (default 0)',
  })
  async getAuditLogs(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ logs: unknown[]; total: number }> {
    return this.protocolAdminService.getProtocolAuditLogs(
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0,
    );
  }

  @Get('audit-logs/admin')
  @Roles(
    AdminRole.SUPER_ADMIN,
    AdminRole.ADMINISTRATOR,
    AdminRole.AUDITOR,
  )
  @ApiOperation({ summary: 'Get administrative action audit logs' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Number of logs (default 50)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'Pagination offset (default 0)',
  })
  async getAdminAuditLogs(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ logs: unknown[]; total: number }> {
    return this.protocolAdminService.getAdminAuditLogs(
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0,
    );
  }
}

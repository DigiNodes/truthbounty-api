import {
  Controller,
  Get,
  Query,
  Param,
  Post,
  Patch,
  Res,
  Headers,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiProduces } from '@nestjs/swagger';
import { AuditTrailService, AuditQueryFilters } from '../services/audit-trail.service';
import { ComplianceService } from '../services/compliance.service';
import { SecurityMonitoringService } from '../services/security-monitoring.service';
import { AuditMetricsService } from '../services/audit-metrics.service';
import { AuditQueueService } from '../services/audit-queue.service';
import { AuditLog, AuditActionType, AuditEntityType } from '../entities/audit-log.entity';
import { AuditQueryDto, ExportAuditDto, ComplianceReportDto } from '../dto/audit-query.dto';
import { AuditPaginatedResponse, AuditResponse } from '../interfaces/audit-response.interface';

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(
    private readonly auditTrailService: AuditTrailService,
    private readonly complianceService: ComplianceService,
    private readonly securityMonitoringService: SecurityMonitoringService,
    private readonly auditMetricsService: AuditMetricsService,
    private readonly auditQueueService: AuditQueueService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Query audit logs with filters and pagination' })
  @ApiResponse({ status: 200, description: 'Paginated audit logs' })
  async queryAuditLogs(
    @Query() query: AuditQueryDto,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditPaginatedResponse<AuditLog>> {
    const filters: AuditQueryFilters = {
      entityType: query.entityType,
      actionType: query.actionType,
      severity: query.severity,
      category: query.category,
      userId: query.userId,
      source: query.source,
      requestId: query.requestId,
      correlationId: query.correlationId,
      search: query.search,
      startDate: query.startDate,
      endDate: query.endDate,
      page: query.page,
      limit: query.limit,
    };

    const result = await this.auditTrailService.query(filters);

    return {
      success: true,
      data: result.logs,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
        hasNext: result.page < result.totalPages,
        hasPrevious: result.page > 1,
      },
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('entity/:entityType/:entityId')
  @ApiOperation({ summary: 'Get audit logs for a specific entity' })
  async getEntityAuditLogs(
    @Param('entityType') entityType: AuditEntityType,
    @Param('entityId') entityId: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<AuditLog[]>> {
    const logs = await this.auditTrailService.getEntityAuditLogs(entityType, entityId);
    return {
      success: true,
      data: logs,
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get audit logs for a specific user' })
  async getUserAuditLogs(
    @Param('userId') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditPaginatedResponse<AuditLog>> {
    const parsedLimit = limit ? Math.min(parseInt(limit, 10), 500) : 100;
    const parsedPage = page ? Math.max(parseInt(page, 10), 1) : 1;
    const offset = (parsedPage - 1) * parsedLimit;

    const { logs, total } = await this.auditTrailService.getUserAuditLogs(
      userId,
      parsedLimit,
      offset,
    );

    const totalPages = Math.ceil(total / parsedLimit);

    return {
      success: true,
      data: logs,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total,
        totalPages,
        hasNext: parsedPage < totalPages,
        hasPrevious: parsedPage > 1,
      },
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('action/:actionType')
  @ApiOperation({ summary: 'Get audit logs for a specific action type' })
  async getActionAuditLogs(
    @Param('actionType') actionType: AuditActionType,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditPaginatedResponse<AuditLog>> {
    const parsedLimit = limit ? Math.min(parseInt(limit, 10), 500) : 100;
    const parsedPage = page ? Math.max(parseInt(page, 10), 1) : 1;
    const offset = (parsedPage - 1) * parsedLimit;

    const { logs, total } = await this.auditTrailService.getActionAuditLogs(
      actionType,
      parsedLimit,
      offset,
    );

    const totalPages = Math.ceil(total / parsedLimit);

    return {
      success: true,
      data: logs,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total,
        totalPages,
        hasNext: parsedPage < totalPages,
        hasPrevious: parsedPage > 1,
      },
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('changes/:entityType/:entityId')
  @ApiOperation({ summary: 'Get change history for a specific entity' })
  async getChangeHistory(
    @Param('entityType') entityType: AuditEntityType,
    @Param('entityId') entityId: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<
    AuditResponse<
      Array<{
        timestamp: Date;
        action: AuditActionType;
        userId: string;
        changes: Record<string, { before: any; after: any }>;
      }>
    >
  > {
    const history = await this.auditTrailService.getChangeHistory(entityType, entityId);
    return {
      success: true,
      data: history,
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('summary')
  @ApiOperation({ summary: 'Get audit summary by action type' })
  async getAuditSummary(
    @Query('entityType') entityType?: AuditEntityType,
    @Query('days') days?: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<Record<string, number>>> {
    const parsedDays = days ? Math.max(parseInt(days, 10), 1) : 7;
    const summary = await this.auditTrailService.getAuditSummary(entityType, parsedDays);
    return {
      success: true,
      data: summary,
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('event/:eventId')
  @ApiOperation({ summary: 'Get audit log by event ID' })
  async getByEventId(
    @Param('eventId') eventId: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<AuditLog | null>> {
    const log = await this.auditTrailService.getAuditLogsByEventId(eventId);
    return {
      success: true,
      data: log,
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('correlation/:correlationId')
  @ApiOperation({ summary: 'Get audit logs by correlation ID' })
  async getByCorrelationId(
    @Param('correlationId') correlationId: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<AuditLog[]>> {
    const logs = await this.auditTrailService.getAuditLogsByCorrelationId(correlationId);
    return {
      success: true,
      data: logs,
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('stats/storage')
  @ApiOperation({ summary: 'Get audit storage statistics' })
  async getStorageStats(
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<any>> {
    const stats = await this.auditTrailService.getStorageStats();
    return {
      success: true,
      data: stats,
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Post('export')
  @ApiOperation({ summary: 'Export audit logs' })
  @ApiProduces('application/json', 'text/csv')
  async exportAuditLogs(
    @Query() query: ExportAuditDto,
    @Res() res: Response,
    @Headers('x-request-id') requestId?: string,
  ): Promise<void> {
    const result = await this.complianceService.exportAuditLogs(query);

    res.setHeader('Content-Type', result.format);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-Request-Id', requestId || '');

    if (query.format === 'csv') {
      res.send(result.data);
    } else {
      res.json(result.data);
    }
  }

  @Get('reports')
  @ApiOperation({ summary: 'Generate compliance report' })
  async generateReport(
    @Query() query: ComplianceReportDto,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<any>> {
    const report = await this.complianceService.generateReport(query);
    return {
      success: true,
      data: report,
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('reports/daily')
  @ApiOperation({ summary: 'Get daily audit activity' })
  async getDailyActivity(
    @Query('days') days?: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<any>> {
    const parsedDays = days ? Math.max(parseInt(days, 10), 1) : 30;
    const activity = await this.complianceService.getDailyActivity(parsedDays);
    return {
      success: true,
      data: activity,
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('reports/categories')
  @ApiOperation({ summary: 'Get audit category summary' })
  async getCategorySummary(
    @Query('days') days?: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<any>> {
    const parsedDays = days ? Math.max(parseInt(days, 10), 1) : 30;
    const summary = await this.complianceService.getCategorySummary(parsedDays);
    return {
      success: true,
      data: summary,
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('security/events')
  @ApiOperation({ summary: 'Get recent security events' })
  async getSecurityEvents(
    @Query('minutes') minutes?: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<any>> {
    const parsedMinutes = minutes ? Math.max(parseInt(minutes, 10), 1) : 60;
    const events = await this.securityMonitoringService.getRecentSecurityEvents(parsedMinutes);
    return {
      success: true,
      data: events,
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('security/failed-logins')
  @ApiOperation({ summary: 'Get failed login report' })
  async getFailedLoginReport(
    @Query('days') days?: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<any>> {
    const parsedDays = days ? Math.max(parseInt(days, 10), 1) : 7;
    const report = await this.securityMonitoringService.getFailedLoginReport(parsedDays);
    return {
      success: true,
      data: report,
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('security/admin-activity')
  @ApiOperation({ summary: 'Get admin activity report' })
  async getAdminActivityReport(
    @Query('days') days?: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<any>> {
    const parsedDays = days ? Math.max(parseInt(days, 10), 1) : 30;
    const report = await this.securityMonitoringService.getAdminActivityReport(parsedDays);
    return {
      success: true,
      data: report,
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('security/check/:userId')
  @ApiOperation({ summary: 'Check for security incidents for a user' })
  async checkUserSecurity(
    @Param('userId') userId: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<any>> {
    const [failedLogin, permissionEscalation] = await Promise.all([
      this.securityMonitoringService.checkFailedLogins(userId),
      this.securityMonitoringService.checkPermissionEscalation(userId),
    ]);

    const incidents = [failedLogin, permissionEscalation].filter(Boolean);

    return {
      success: true,
      data: { userId, incidents, hasIncidents: incidents.length > 0 },
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('retention')
  @ApiOperation({ summary: 'Get audit retention status' })
  async getRetentionStatus(
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<any>> {
    const status = await this.auditTrailService.getRetentionStatus();
    return {
      success: true,
      data: status,
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Post('legal-hold/:entityType/:entityId')
  @ApiOperation({ summary: 'Place a legal hold on all audit logs for an entity' })
  async placeLegalHold(
    @Param('entityType') entityType: AuditEntityType,
    @Param('entityId') entityId: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<any>> {
    const affected = await this.auditTrailService.placeLegalHold(entityType, entityId);
    return {
      success: true,
      data: { entityType, entityId, affected },
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Patch('legal-hold/:entityType/:entityId/remove')
  @ApiOperation({ summary: 'Remove legal hold from audit logs for an entity' })
  async removeLegalHold(
    @Param('entityType') entityType: AuditEntityType,
    @Param('entityId') entityId: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<any>> {
    const affected = await this.auditTrailService.removeLegalHold(entityType, entityId);
    return {
      success: true,
      data: { entityType, entityId, affected },
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('integrity/:id')
  @ApiOperation({ summary: 'Verify the integrity hash of an audit log' })
  async verifyIntegrity(
    @Param('id') id: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<any>> {
    const result = await this.auditTrailService.verifyIntegrity(id);
    return {
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Get audit system metrics' })
  async getMetrics(
    @Headers('x-request-id') requestId?: string,
  ): Promise<AuditResponse<any>> {
    await this.auditMetricsService.updateStorageMetrics();
    const metrics = {
      storage: await this.auditTrailService.getStorageStats(),
      queue: await this.auditQueueService.getQueueStats(),
    };
    return {
      success: true,
      data: metrics,
      timestamp: new Date().toISOString(),
      requestId,
    };
  }
}

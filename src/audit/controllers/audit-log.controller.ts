import {
  Controller, Get, Post, Patch, Query, Param, Body,
  UseGuards, Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery, ApiBody } from '@nestjs/swagger';
import { AuditTrailService } from '../services/audit-trail.service';
import { AuditSearchService } from '../services/audit-search.service';
import { AuditComplianceService } from '../services/audit-compliance.service';
import { AuditMetricsService } from '../services/audit-metrics.service';
import { AuditRetentionService } from '../services/audit-retention.service';
import { AuditLog, AuditActionType, AuditEntityType } from '../entities/audit-log.entity';
import { SearchAuditDto } from '../dto/search-audit.dto';
import { GenerateReportDto, ReportType, ReportFormat } from '../dto/compliance-report.dto';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { UserRole } from '../../entities/user.entity';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(
    private readonly auditTrailService: AuditTrailService,
    private readonly auditSearchService: AuditSearchService,
    private readonly auditComplianceService: AuditComplianceService,
    private readonly auditMetricsService: AuditMetricsService,
    private readonly auditRetentionService: AuditRetentionService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Search audit logs with advanced filters' })
  @ApiResponse({ status: 200, description: 'Returns filtered audit logs' })
  async search(@Query() dto: SearchAuditDto): Promise<any> {
    const startTime = Date.now();
    const result = await this.auditSearchService.search(dto);
    this.auditMetricsService.recordSearchOperation(Date.now() - startTime);
    return result;
  }

  @Get('entity/:entityType/:entityId')
  @ApiOperation({ summary: 'Get audit logs for a specific entity' })
  async getEntityAuditLogs(
    @Param('entityType') entityType: AuditEntityType,
    @Param('entityId') entityId: string,
  ): Promise<AuditLog[]> {
    return this.auditTrailService.getEntityAuditLogs(entityType, entityId);
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get audit logs for a specific user' })
  async getUserAuditLogs(
    @Param('userId') userId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ logs: AuditLog[]; total: number }> {
    const parsedLimit = limit ? Math.min(parseInt(limit, 10), 500) : 100;
    const parsedOffset = offset ? Math.max(parseInt(offset, 10), 0) : 0;
    return this.auditTrailService.getUserAuditLogs(userId, parsedLimit, parsedOffset);
  }

  @Get('action/:actionType')
  @ApiOperation({ summary: 'Get audit logs by action type' })
  async getActionAuditLogs(
    @Param('actionType') actionType: AuditActionType,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ logs: AuditLog[]; total: number }> {
    const parsedLimit = limit ? Math.min(parseInt(limit, 10), 500) : 100;
    const parsedOffset = offset ? Math.max(parseInt(offset, 10), 0) : 0;
    return this.auditTrailService.getActionAuditLogs(actionType, parsedLimit, parsedOffset);
  }

  @Get('changes/:entityType/:entityId')
  @ApiOperation({ summary: 'Get change history for a specific entity' })
  async getChangeHistory(
    @Param('entityType') entityType: AuditEntityType,
    @Param('entityId') entityId: string,
  ): Promise<
    Array<{
      timestamp: Date;
      action: AuditActionType;
      userId: string;
      changes: Record<string, { before: any; after: any }>;
    }>
  > {
    return this.auditTrailService.getChangeHistory(entityType, entityId);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Get audit summary grouped by action type' })
  async getAuditSummary(
    @Query('entityType') entityType?: AuditEntityType,
    @Query('days') days?: string,
  ): Promise<Record<string, number>> {
    const parsedDays = days ? Math.max(parseInt(days, 10), 1) : 7;
    return this.auditTrailService.getAuditSummary(entityType, parsedDays);
  }

  @Get('correlation/:correlationId')
  @ApiOperation({ summary: 'Get audit logs by correlation ID' })
  async getByCorrelationId(
    @Param('correlationId') correlationId: string,
  ): Promise<AuditLog[]> {
    return this.auditSearchService.findByCorrelationId(correlationId);
  }

  @Get('request/:requestId')
  @ApiOperation({ summary: 'Get audit logs by request ID' })
  async getByRequestId(
    @Param('requestId') requestId: string,
  ): Promise<AuditLog[]> {
    return this.auditSearchService.findByRequestId(requestId);
  }

  @Get('failed-access')
  @ApiOperation({ summary: 'Get failed access attempts' })
  async getFailedAccess(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ logs: AuditLog[]; total: number }> {
    return this.auditSearchService.findFailedAccessAttempts(
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
      limit ? Math.min(parseInt(limit, 10), 500) : 100,
      offset ? Math.max(parseInt(offset, 10), 0) : 0,
    );
  }

  @Get('security-events')
  @ApiOperation({ summary: 'Get security event audit logs' })
  async getSecurityEvents(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ logs: AuditLog[]; total: number }> {
    return this.auditSearchService.findSecurityEvents(
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
      limit ? Math.min(parseInt(limit, 10), 500) : 100,
      offset ? Math.max(parseInt(offset, 10), 0) : 0,
    );
  }

  @Get('integrity/:id')
  @ApiOperation({ summary: 'Verify integrity of an audit record' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async verifyIntegrity(@Param('id') id: string): Promise<{ valid: boolean; id: string }> {
    const result = await this.auditTrailService.verifyIntegrity(id);
    return { valid: result.valid, id };
  }

  @Post('reports')
  @ApiOperation({ summary: 'Generate a compliance report' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async generateReport(
    @Body() dto: GenerateReportDto,
    @CurrentUser() user: any,
  ): Promise<any> {
    this.auditMetricsService.incrementExportRequests();
    return this.auditComplianceService.generateReport(dto, user?.id || 'system');
  }

  @Get('reports/types')
  @ApiOperation({ summary: 'Get available report types' })
  getReportTypes(): { types: string[] } {
    return { types: Object.values(ReportType) };
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Get audit system metrics' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async getMetrics(): Promise<any> {
    return this.auditMetricsService.getMetrics();
  }

  @Get('retention')
  @ApiOperation({ summary: 'Get retention policy status' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async getRetentionStatus(): Promise<any> {
    const status = await this.auditTrailService.getRetentionStatus();
    const config = this.auditRetentionService.getRetentionConfig();
    return { ...status, config };
  }

  @Post('legal-hold/:entityId')
  @ApiOperation({ summary: 'Place legal hold on audit records for an entity' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiBody({ schema: { properties: { reason: { type: 'string' }, initiatedBy: { type: 'string' } } } })
  async placeLegalHold(
    @Param('entityId') entityId: string,
    @Body('reason') reason: string,
    @CurrentUser() user: any,
  ): Promise<{ affected: number }> {
    const affected = await this.auditTrailService.placeLegalHold(
      entityId,
      reason || 'Legal hold',
      user?.id || 'system',
    );
    return { affected };
  }

  @Patch('legal-hold/:entityId/remove')
  @ApiOperation({ summary: 'Remove legal hold from audit records' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async removeLegalHold(
    @Param('entityId') entityId: string,
  ): Promise<{ affected: number }> {
    const affected = await this.auditTrailService.removeLegalHold(entityId);
    return { affected };
  }
}

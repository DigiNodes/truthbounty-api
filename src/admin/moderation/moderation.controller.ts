import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger';
import { ModerationService } from './moderation.service';
import { AdminGuard } from '../guards/admin.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { CurrentAdmin } from '../decorators/current-admin.decorator';
import { Admin, AdminRole } from '../entities/admin.entity';
import {
  CreateReportDto,
  UpdateReportDto,
  ResolveReportDto,
  AssignDto,
  ModerationQueryDto,
} from '../dto/moderation.dto';

@ApiTags('admin / moderation')
@ApiBearerAuth()
@Controller('admin/moderation')
@UseGuards(AdminGuard, RolesGuard)
export class ModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  @Get('queue')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.MODERATOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Get moderation queue' })
  @ApiResponse({ status: 200, description: 'Moderation queue items' })
  async getQueue(@Query() query: ModerationQueryDto) {
    return this.moderationService.findAll(query);
  }

  @Get('queue/:id')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.MODERATOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Get moderation queue item details' })
  @ApiParam({ name: 'id', description: 'Report ID' })
  async getQueueItem(@Param('id') id: string) {
    return this.moderationService.findById(id);
  }

  @Patch('queue/:id')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.MODERATOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Update queue item' })
  @ApiParam({ name: 'id', description: 'Report ID' })
  async updateQueueItem(
    @Param('id') id: string,
    @Body() updateDto: UpdateReportDto,
    @CurrentAdmin() admin: Admin,
  ) {
    return this.moderationService.update(id, updateDto, admin);
  }

  @Post('reports')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.MODERATOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Create a moderation report' })
  @ApiResponse({ status: 201, description: 'Report created' })
  async createReport(@Body() createDto: CreateReportDto, @CurrentAdmin() admin: Admin) {
    return this.moderationService.createReport(createDto, admin);
  }

  @Get('reports')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.MODERATOR, AdminRole.SECURITY_ANALYST, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'List all reports' })
  async listReports(@Query() query: ModerationQueryDto) {
    return this.moderationService.findAll(query);
  }

  @Get('reports/:id')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.MODERATOR, AdminRole.SECURITY_ANALYST, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'Get report details' })
  @ApiParam({ name: 'id', description: 'Report ID' })
  async getReport(@Param('id') id: string) {
    return this.moderationService.findById(id);
  }

  @Patch('reports/:id')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.MODERATOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Update report' })
  @ApiParam({ name: 'id', description: 'Report ID' })
  async updateReport(
    @Param('id') id: string,
    @Body() updateDto: UpdateReportDto,
    @CurrentAdmin() admin: Admin,
  ) {
    return this.moderationService.update(id, updateDto, admin);
  }

  @Post('reports/:id/assign')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.MODERATOR)
  @ApiOperation({ summary: 'Assign report to a moderator' })
  @ApiParam({ name: 'id', description: 'Report ID' })
  async assignReport(
    @Param('id') id: string,
    @Body() assignDto: AssignDto,
    @CurrentAdmin() admin: Admin,
  ) {
    return this.moderationService.assign(id, assignDto, admin);
  }

  @Post('reports/:id/resolve')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.MODERATOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Resolve a report' })
  @ApiParam({ name: 'id', description: 'Report ID' })
  async resolveReport(
    @Param('id') id: string,
    @Body() resolveDto: ResolveReportDto,
    @CurrentAdmin() admin: Admin,
  ) {
    return this.moderationService.resolve(id, resolveDto, admin);
  }

  @Get('stats')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.MODERATOR, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'Get moderation statistics' })
  async getStats() {
    return this.moderationService.getStats();
  }
}

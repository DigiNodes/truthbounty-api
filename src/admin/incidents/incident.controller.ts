import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger';
import { IncidentService } from './incident.service';
import { AdminGuard } from '../guards/admin.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { CurrentAdmin } from '../decorators/current-admin.decorator';
import { Admin, AdminRole } from '../entities/admin.entity';
import {
  CreateIncidentDto,
  UpdateIncidentDto,
  AddInvestigationNoteDto,
  ResolveIncidentDto,
  PostIncidentReportDto,
  IncidentQueryDto,
} from '../dto/incident.dto';

@ApiTags('admin / incidents')
@ApiBearerAuth()
@Controller('admin/incidents')
@UseGuards(AdminGuard, RolesGuard)
export class IncidentController {
  constructor(private readonly incidentService: IncidentService) {}

  @Post()
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Create a new incident' })
  @ApiResponse({ status: 201, description: 'Incident created' })
  async create(@Body() createDto: CreateIncidentDto, @CurrentAdmin() admin: Admin) {
    return this.incidentService.create(createDto, admin);
  }

  @Get()
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.SECURITY_ANALYST, AdminRole.MODERATOR, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'List all incidents' })
  async findAll(@Query() query: IncidentQueryDto) {
    return this.incidentService.findAll(query);
  }

  @Get(':id')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.SECURITY_ANALYST, AdminRole.MODERATOR, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'Get incident details' })
  @ApiParam({ name: 'id', description: 'Incident ID' })
  async findById(@Param('id') id: string) {
    return this.incidentService.findById(id);
  }

  @Patch(':id')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Update incident' })
  @ApiParam({ name: 'id', description: 'Incident ID' })
  async update(
    @Param('id') id: string,
    @Body() updateDto: UpdateIncidentDto,
    @CurrentAdmin() admin: Admin,
  ) {
    return this.incidentService.update(id, updateDto, admin);
  }

  @Post(':id/assign')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Assign incident to an investigator' })
  @ApiParam({ name: 'id', description: 'Incident ID' })
  async assign(
    @Param('id') id: string,
    @Body('assigneeId') assigneeId: string,
    @CurrentAdmin() admin: Admin,
  ) {
    return this.incidentService.assign(id, assigneeId, admin);
  }

  @Post(':id/notes')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Add investigation note' })
  @ApiParam({ name: 'id', description: 'Incident ID' })
  async addNote(
    @Param('id') id: string,
    @Body() noteDto: AddInvestigationNoteDto,
    @CurrentAdmin() admin: Admin,
  ) {
    return this.incidentService.addNote(id, noteDto, admin);
  }

  @Post(':id/resolve')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Resolve an incident' })
  @ApiParam({ name: 'id', description: 'Incident ID' })
  async resolve(
    @Param('id') id: string,
    @Body() resolveDto: ResolveIncidentDto,
    @CurrentAdmin() admin: Admin,
  ) {
    return this.incidentService.resolve(id, resolveDto, admin);
  }

  @Post(':id/report')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.SECURITY_ANALYST)
  @ApiOperation({ summary: 'Submit post-incident report' })
  @ApiParam({ name: 'id', description: 'Incident ID' })
  async addReport(
    @Param('id') id: string,
    @Body() reportDto: PostIncidentReportDto,
    @CurrentAdmin() admin: Admin,
  ) {
    return this.incidentService.addPostIncidentReport(id, reportDto, admin);
  }

  @Get('stats/summary')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.SECURITY_ANALYST, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'Get incident statistics' })
  async getStats() {
    return this.incidentService.getStats();
  }
}

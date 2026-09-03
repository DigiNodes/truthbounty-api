import { Injectable, NotFoundException, Logger, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import {
  Incident,
  IncidentStatus,
  IncidentSeverity,
  IncidentClassification,
} from '../entities/incident.entity';
import { AuditTrailService } from '../../audit/services/audit-trail.service';
import { AuditActionType, AuditEntityType } from '../../audit/entities/audit-log.entity';
import {
  CreateIncidentDto,
  UpdateIncidentDto,
  AddInvestigationNoteDto,
  ResolveIncidentDto,
  PostIncidentReportDto,
  IncidentQueryDto,
} from '../dto/incident.dto';
import { Admin, AdminRole } from '../entities/admin.entity';

@Injectable()
export class IncidentService {
  private readonly logger = new Logger(IncidentService.name);

  constructor(
    @InjectRepository(Incident)
    private readonly incidentRepo: Repository<Incident>,
    private readonly auditTrailService: AuditTrailService,
  ) {}

  async create(createDto: CreateIncidentDto, admin: Admin): Promise<Incident> {
    const incident = this.incidentRepo.create({
      title: createDto.title,
      description: createDto.description,
      classification: createDto.classification,
      severity: createDto.severity,
      status: IncidentStatus.OPEN,
      reportedBy: admin.id,
      relatedEntityType: createDto.relatedEntityType,
      relatedEntityId: createDto.relatedEntityId,
    });

    const saved = await this.incidentRepo.save(incident);

    await this.auditTrailService.log({
      actionType: AuditActionType.CLAIM_CREATED,
      entityType: AuditEntityType.CLAIM,
      entityId: saved.id,
      userId: admin.id,
      walletAddress: admin.walletAddress,
      description: `Incident created: ${saved.title} (${saved.severity})`,
      metadata: {
        classification: saved.classification,
        severity: saved.severity,
        adminRole: admin.role,
      },
    });

    this.logger.log(`Incident created: ${saved.id} - ${saved.title} [${saved.severity}]`);
    return saved;
  }

  async findAll(query: IncidentQueryDto): Promise<{
    data: Incident[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = parseInt(query.page || '1', 10);
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const where: any = {};

    if (query.status) where.status = query.status;
    if (query.severity) where.severity = query.severity;
    if (query.classification) where.classification = query.classification;
    if (query.assignedTo) where.assignedTo = query.assignedTo;
    if (query.search) {
      where.title = Like(`%${query.search}%`);
    }
    if (query.fromDate || query.toDate) {
      const dateFilter: any = {};
      if (query.fromDate) dateFilter.gte = new Date(query.fromDate);
      if (query.toDate) dateFilter.lte = new Date(query.toDate);
      where.createdAt = dateFilter;
    }

    const [data, total] = await this.incidentRepo.findAndCount({
      where,
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return { data, total, page, limit };
  }

  async findById(id: string): Promise<Incident> {
    const incident = await this.incidentRepo.findOneBy({ id });
    if (!incident) {
      throw new NotFoundException(`Incident ${id} not found`);
    }
    return incident;
  }

  async update(id: string, updateDto: UpdateIncidentDto, admin: Admin): Promise<Incident> {
    const incident = await this.findById(id);

    if (incident.status === IncidentStatus.CLOSED) {
      throw new ForbiddenException('Cannot update a closed incident');
    }

    if (updateDto.title) incident.title = updateDto.title;
    if (updateDto.description) incident.description = updateDto.description;
    if (updateDto.classification) incident.classification = updateDto.classification;
    if (updateDto.severity) incident.severity = updateDto.severity;
    if (updateDto.status) incident.status = updateDto.status;

    if (updateDto.status === IncidentStatus.RESOLVED) {
      incident.resolvedAt = new Date();
    }

    const saved = await this.incidentRepo.save(incident);

    await this.auditTrailService.log({
      actionType: AuditActionType.CLAIM_UPDATED,
      entityType: AuditEntityType.CLAIM,
      entityId: id,
      userId: admin.id,
      walletAddress: admin.walletAddress,
      description: `Incident updated: status=${updateDto.status || 'unchanged'}`,
      metadata: { updates: updateDto },
    });

    return saved;
  }

  async assign(id: string, assigneeId: string, admin: Admin): Promise<Incident> {
    const incident = await this.findById(id);

    incident.assignedTo = assigneeId;
    if (incident.status === IncidentStatus.OPEN) {
      incident.status = IncidentStatus.INVESTIGATING;
    }

    const saved = await this.incidentRepo.save(incident);

    await this.auditTrailService.log({
      actionType: AuditActionType.CLAIM_UPDATED,
      entityType: AuditEntityType.CLAIM,
      entityId: id,
      userId: admin.id,
      walletAddress: admin.walletAddress,
      description: `Incident assigned to ${assigneeId}`,
    });

    return saved;
  }

  async addNote(id: string, noteDto: AddInvestigationNoteDto, admin: Admin): Promise<Incident> {
    const incident = await this.findById(id);

    const notes = incident.investigationNotes || [];
    notes.push({
      author: admin.id,
      content: noteDto.content,
      createdAt: new Date().toISOString(),
    });
    incident.investigationNotes = notes;

    const saved = await this.incidentRepo.save(incident);

    await this.auditTrailService.log({
      actionType: AuditActionType.CLAIM_UPDATED,
      entityType: AuditEntityType.CLAIM,
      entityId: id,
      userId: admin.id,
      walletAddress: admin.walletAddress,
      description: 'Investigation note added',
    });

    return saved;
  }

  async resolve(id: string, resolveDto: ResolveIncidentDto, admin: Admin): Promise<Incident> {
    const incident = await this.findById(id);

    incident.status = IncidentStatus.RESOLVED;
    incident.resolution = {
      summary: resolveDto.summary,
      actions: resolveDto.actions,
      resolvedBy: admin.id,
      resolvedAt: new Date().toISOString(),
    };
    incident.resolvedAt = new Date();

    const saved = await this.incidentRepo.save(incident);

    await this.auditTrailService.log({
      actionType: AuditActionType.CLAIM_RESOLVED,
      entityType: AuditEntityType.CLAIM,
      entityId: id,
      userId: admin.id,
      walletAddress: admin.walletAddress,
      description: `Incident resolved: ${resolveDto.summary}`,
      metadata: { resolution: resolveDto },
    });

    return saved;
  }

  async addPostIncidentReport(id: string, reportDto: PostIncidentReportDto, admin: Admin): Promise<Incident> {
    const incident = await this.findById(id);

    incident.postIncidentReport = {
      rootCause: reportDto.rootCause,
      impact: reportDto.impact,
      preventiveActions: reportDto.preventiveActions,
      lessonsLearned: reportDto.lessonsLearned,
      reportAuthor: admin.id,
      completedAt: new Date().toISOString(),
    };

    const saved = await this.incidentRepo.save(incident);

    await this.auditTrailService.log({
      actionType: AuditActionType.CLAIM_FINALIZED,
      entityType: AuditEntityType.CLAIM,
      entityId: id,
      userId: admin.id,
      walletAddress: admin.walletAddress,
      description: 'Post-incident report completed',
    });

    return saved;
  }

  async getStats(): Promise<{
    total: number;
    open: number;
    investigating: number;
    resolved: number;
    closed: number;
    bySeverity: Record<string, number>;
    byClassification: Record<string, number>;
    avgResolutionTimeHours: number;
  }> {
    const total = await this.incidentRepo.count();
    const open = await this.incidentRepo.count({ where: { status: IncidentStatus.OPEN } });
    const investigating = await this.incidentRepo.count({ where: { status: IncidentStatus.INVESTIGATING } });
    const resolved = await this.incidentRepo.count({ where: { status: IncidentStatus.RESOLVED } });
    const closed = await this.incidentRepo.count({ where: { status: IncidentStatus.CLOSED } });

    const bySeverityRaw = await this.incidentRepo
      .createQueryBuilder('i')
      .select('i.severity', 'severity')
      .addSelect('COUNT(*)', 'count')
      .groupBy('i.severity')
      .getRawMany();

    const byClassificationRaw = await this.incidentRepo
      .createQueryBuilder('i')
      .select('i.classification', 'classification')
      .addSelect('COUNT(*)', 'count')
      .groupBy('i.classification')
      .getRawMany();

    const bySeverity: Record<string, number> = {};
    bySeverityRaw.forEach((r) => { bySeverity[r.severity] = parseInt(r.count, 10); });

    const byClassification: Record<string, number> = {};
    byClassificationRaw.forEach((r) => { byClassification[r.classification] = parseInt(r.count, 10); });

    let avgResolutionTimeHours = 0;
    const resolvedIncidents = await this.incidentRepo.find({
      where: [
        { status: IncidentStatus.RESOLVED },
        { status: IncidentStatus.CLOSED },
      ],
    });
    if (resolvedIncidents.length > 0) {
      const totalHours = resolvedIncidents.reduce((sum, inc) => {
        const created = new Date(inc.createdAt).getTime();
        const resolvedAt = inc.resolvedAt ? new Date(inc.resolvedAt).getTime() : Date.now();
        return sum + (resolvedAt - created) / (1000 * 60 * 60);
      }, 0);
      avgResolutionTimeHours = Math.round((totalHours / resolvedIncidents.length) * 100) / 100;
    }

    return { total, open, investigating, resolved, closed, bySeverity, byClassification, avgResolutionTimeHours };
  }
}

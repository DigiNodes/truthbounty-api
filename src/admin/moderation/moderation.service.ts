import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { ModerationReport, ReportStatus, ReportType, ReportPriority } from '../entities/moderation-report.entity';
import { AuditTrailService } from '../../audit/services/audit-trail.service';
import { AuditActionType, AuditEntityType } from '../../audit/entities/audit-log.entity';
import { CreateReportDto, UpdateReportDto, ResolveReportDto, AssignDto, ModerationQueryDto } from '../dto/moderation.dto';
import { Admin } from '../entities/admin.entity';

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    @InjectRepository(ModerationReport)
    private readonly reportRepo: Repository<ModerationReport>,
    private readonly auditTrailService: AuditTrailService,
  ) {}

  async createReport(createReportDto: CreateReportDto, admin: Admin): Promise<ModerationReport> {
    const report = this.reportRepo.create({
      type: createReportDto.type,
      title: createReportDto.title,
      description: createReportDto.description,
      reportedBy: createReportDto.reportedBy || admin.walletAddress,
      reportedUser: createReportDto.reportedUser,
      targetId: createReportDto.targetId,
      targetType: createReportDto.targetType,
      status: ReportStatus.PENDING,
      priority: ReportPriority.MEDIUM,
      evidence: createReportDto.evidence ? [createReportDto.evidence] as any : null,
      metadata: createReportDto.metadata,
    });

    const saved = await this.reportRepo.save(report);

    await this.auditTrailService.log({
      actionType: AuditActionType.USER_CREATED,
      entityType: AuditEntityType.USER,
      entityId: saved.id,
      userId: admin.id,
      walletAddress: admin.walletAddress,
      description: `Report created: ${saved.title}`,
      metadata: { reportType: saved.type, adminRole: admin.role },
    });

    this.logger.log(`Moderation report created: ${saved.id} (${saved.type})`);
    return saved;
  }

  async findAll(query: ModerationQueryDto): Promise<{
    data: ModerationReport[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = parseInt(query.page || '1', 10);
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const where: any = {};

    if (query.status) where.status = query.status;
    if (query.type) where.type = query.type;
    if (query.priority) where.priority = query.priority;
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

    const [data, total] = await this.reportRepo.findAndCount({
      where,
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return { data, total, page, limit };
  }

  async findById(id: string): Promise<ModerationReport> {
    const report = await this.reportRepo.findOneBy({ id });
    if (!report) {
      throw new NotFoundException(`Moderation report ${id} not found`);
    }
    return report;
  }

  async update(id: string, updateDto: UpdateReportDto, admin: Admin): Promise<ModerationReport> {
    const report = await this.findById(id);

    if (updateDto.status) report.status = updateDto.status;
    if (updateDto.priority) report.priority = updateDto.priority;
    if (updateDto.title) report.title = updateDto.title;
    if (updateDto.description) report.description = updateDto.description;

    if (updateDto.status === ReportStatus.RESOLVED || updateDto.status === ReportStatus.DISMISSED) {
      report.resolvedAt = new Date();
    }

    const saved = await this.reportRepo.save(report);

    await this.auditTrailService.log({
      actionType: AuditActionType.USER_UPDATED,
      entityType: AuditEntityType.USER,
      entityId: id,
      userId: admin.id,
      walletAddress: admin.walletAddress,
      description: `Report updated: status=${updateDto.status || 'unchanged'}`,
      metadata: { updates: updateDto, adminRole: admin.role },
    });

    return saved;
  }

  async assign(id: string, assignDto: AssignDto, admin: Admin): Promise<ModerationReport> {
    const report = await this.findById(id);

    report.assignedTo = assignDto.assigneeId;
    if (report.status === ReportStatus.PENDING) {
      report.status = ReportStatus.UNDER_REVIEW;
    }

    const saved = await this.reportRepo.save(report);

    await this.auditTrailService.log({
      actionType: AuditActionType.USER_UPDATED,
      entityType: AuditEntityType.USER,
      entityId: id,
      userId: admin.id,
      walletAddress: admin.walletAddress,
      description: `Report assigned to ${assignDto.assigneeId}`,
    });

    return saved;
  }

  async resolve(id: string, resolveDto: ResolveReportDto, admin: Admin): Promise<ModerationReport> {
    const report = await this.findById(id);

    report.status = ReportStatus.RESOLVED;
    report.resolution = {
      action: resolveDto.action,
      notes: resolveDto.notes,
      resolvedBy: admin.id,
      resolvedAt: new Date().toISOString(),
    };
    report.resolvedAt = new Date();

    const saved = await this.reportRepo.save(report);

    await this.auditTrailService.log({
      actionType: AuditActionType.USER_UPDATED,
      entityType: AuditEntityType.USER,
      entityId: id,
      userId: admin.id,
      walletAddress: admin.walletAddress,
      description: `Report resolved: ${resolveDto.action}`,
      metadata: { resolution: resolveDto },
    });

    return saved;
  }

  async getStats(): Promise<{
    total: number;
    pending: number;
    underReview: number;
    resolved: number;
    dismissed: number;
    byType: Record<string, number>;
    byPriority: Record<string, number>;
    avgResolutionTimeHours: number;
  }> {
    const total = await this.reportRepo.count();
    const pending = await this.reportRepo.count({ where: { status: ReportStatus.PENDING } });
    const underReview = await this.reportRepo.count({ where: { status: ReportStatus.UNDER_REVIEW } });
    const resolved = await this.reportRepo.count({ where: { status: ReportStatus.RESOLVED } });
    const dismissed = await this.reportRepo.count({ where: { status: ReportStatus.DISMISSED } });

    const byTypeRaw = await this.reportRepo
      .createQueryBuilder('r')
      .select('r.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .groupBy('r.type')
      .getRawMany();

    const byPriorityRaw = await this.reportRepo
      .createQueryBuilder('r')
      .select('r.priority', 'priority')
      .addSelect('COUNT(*)', 'count')
      .groupBy('r.priority')
      .getRawMany();

    const byType: Record<string, number> = {};
    byTypeRaw.forEach((r) => { byType[r.type] = parseInt(r.count, 10); });

    const byPriority: Record<string, number> = {};
    byPriorityRaw.forEach((r) => { byPriority[r.priority] = parseInt(r.count, 10); });

    let avgResolutionTimeHours = 0;
    const resolvedReports = await this.reportRepo.find({
      where: { status: ReportStatus.RESOLVED },
    });
    if (resolvedReports.length > 0) {
      const totalHours = resolvedReports.reduce((sum, r) => {
        const created = new Date(r.createdAt).getTime();
        const resolved = r.resolvedAt ? new Date(r.resolvedAt).getTime() : Date.now();
        return sum + (resolved - created) / (1000 * 60 * 60);
      }, 0);
      avgResolutionTimeHours = Math.round((totalHours / resolvedReports.length) * 100) / 100;
    }

    return { total, pending, underReview, resolved, dismissed, byType, byPriority, avgResolutionTimeHours };
  }
}

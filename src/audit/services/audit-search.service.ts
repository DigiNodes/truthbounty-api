import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog, AuditActionType, AuditEntityType, AuditEventType, AuditSeverity } from '../entities/audit-log.entity';
import { SearchAuditDto } from '../dto/search-audit.dto';

export interface SearchResult {
  logs: AuditLog[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  query: {
    filters: Record<string, any>;
    dateRange?: { start?: string; end?: string };
    searchTerm?: string;
  };
}

@Injectable()
export class AuditSearchService {
  private readonly logger = new Logger(AuditSearchService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
  ) {}

  async search(dto: SearchAuditDto): Promise<SearchResult> {
    const query = this.auditLogRepo
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .orderBy('audit.createdAt', dto.sortOrder || 'DESC');

    if (dto.actionType) {
      query.andWhere('audit.actionType = :actionType', { actionType: dto.actionType });
    }

    if (dto.entityType) {
      query.andWhere('audit.entityType = :entityType', { entityType: dto.entityType });
    }

    if (dto.eventType) {
      query.andWhere('audit.eventType = :eventType', { eventType: dto.eventType });
    }

    if (dto.severity) {
      query.andWhere('audit.severity = :severity', { severity: dto.severity });
    }

    if (dto.userId) {
      query.andWhere('audit.userId = :userId', { userId: dto.userId });
    }

    if (dto.actorRole) {
      query.andWhere('audit.actorRole = :actorRole', { actorRole: dto.actorRole });
    }

    if (dto.entityId) {
      query.andWhere('audit.entityId = :entityId', { entityId: dto.entityId });
    }

    if (dto.resourceType) {
      query.andWhere('audit.resourceType = :resourceType', { resourceType: dto.resourceType });
    }

    if (dto.correlationId) {
      query.andWhere('audit.correlationId = :correlationId', { correlationId: dto.correlationId });
    }

    if (dto.requestId) {
      query.andWhere('audit.requestId = :requestId', { requestId: dto.requestId });
    }

    if (dto.ipAddress) {
      query.andWhere('audit.ipAddress LIKE :ipAddress', { ipAddress: `%${dto.ipAddress}%` });
    }

    if (dto.walletAddress) {
      query.andWhere('audit.walletAddress = :walletAddress', { walletAddress: dto.walletAddress });
    }

    if (dto.searchTerm) {
      query.andWhere(
        '(audit.description LIKE :searchTerm OR audit.entityId LIKE :searchTerm OR audit.metadata LIKE :searchTerm)',
        { searchTerm: `%${dto.searchTerm}%` },
      );
    }

    if (dto.startDate) {
      query.andWhere('audit.createdAt >= :startDate', { startDate: new Date(dto.startDate) });
    }

    if (dto.endDate) {
      query.andWhere('audit.createdAt <= :endDate', { endDate: new Date(dto.endDate) });
    }

    const limit = dto.limit || 100;
    const offset = dto.offset || 0;

    const [logs, total] = await query
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return {
      logs,
      total,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
      totalPages: Math.ceil(total / limit),
      query: {
        filters: {
          ...(dto.actionType && { actionType: dto.actionType }),
          ...(dto.entityType && { entityType: dto.entityType }),
          ...(dto.eventType && { eventType: dto.eventType }),
          ...(dto.severity && { severity: dto.severity }),
          ...(dto.userId && { userId: dto.userId }),
          ...(dto.actorRole && { actorRole: dto.actorRole }),
          ...(dto.entityId && { entityId: dto.entityId }),
          ...(dto.resourceType && { resourceType: dto.resourceType }),
          ...(dto.correlationId && { correlationId: dto.correlationId }),
          ...(dto.requestId && { requestId: dto.requestId }),
          ...(dto.ipAddress && { ipAddress: dto.ipAddress }),
          ...(dto.walletAddress && { walletAddress: dto.walletAddress }),
        },
        dateRange: {
          ...(dto.startDate && { start: dto.startDate }),
          ...(dto.endDate && { end: dto.endDate }),
        },
        searchTerm: dto.searchTerm,
      },
    };
  }

  async findByCorrelationId(correlationId: string): Promise<AuditLog[]> {
    return this.auditLogRepo.find({
      where: { correlationId },
      order: { createdAt: 'ASC' },
    });
  }

  async findByRequestId(requestId: string): Promise<AuditLog[]> {
    return this.auditLogRepo.find({
      where: { requestId },
      order: { createdAt: 'ASC' },
    });
  }

  async findFailedAccessAttempts(
    startDate?: Date,
    endDate?: Date,
    limit = 100,
    offset = 0,
  ): Promise<{ logs: AuditLog[]; total: number }> {
    const query = this.auditLogRepo
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .where('audit.actionType IN (:...types)', {
        types: [AuditActionType.LOGIN_FAILED, AuditActionType.AUTHORIZATION_FAILED, AuditActionType.PERMISSION_DENIED],
      })
      .orderBy('audit.createdAt', 'DESC');

    if (startDate) {
      query.andWhere('audit.createdAt >= :startDate', { startDate });
    }
    if (endDate) {
      query.andWhere('audit.createdAt <= :endDate', { endDate });
    }

    const [logs, total] = await query.skip(offset).take(limit).getManyAndCount();
    return { logs, total };
  }

  async findSecurityEvents(
    startDate?: Date,
    endDate?: Date,
    limit = 100,
    offset = 0,
  ): Promise<{ logs: AuditLog[]; total: number }> {
    const query = this.auditLogRepo
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .where('audit.eventType = :eventType', { eventType: AuditEventType.SECURITY })
      .orderBy('audit.createdAt', 'DESC');

    if (startDate) {
      query.andWhere('audit.createdAt >= :startDate', { startDate });
    }
    if (endDate) {
      query.andWhere('audit.createdAt <= :endDate', { endDate });
    }

    const [logs, total] = await query.skip(offset).take(limit).getManyAndCount();
    return { logs, total };
  }
}

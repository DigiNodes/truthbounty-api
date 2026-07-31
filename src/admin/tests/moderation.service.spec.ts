import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ModerationService } from '../moderation/moderation.service';
import { ModerationReport, ReportStatus, ReportType, ReportPriority } from '../entities/moderation-report.entity';
import { Admin, AdminRole } from '../entities/admin.entity';
import { AuditTrailService } from '../../audit/services/audit-trail.service';

describe('ModerationService', () => {
  let service: ModerationService;
  let reportRepo: jest.Mocked<Repository<ModerationReport>>;
  let auditTrailService: jest.Mocked<AuditTrailService>;

  const mockAdmin: Admin = {
    id: 'admin-1',
    walletAddress: '0xabc',
    role: AdminRole.MODERATOR,
    isActive: true,
    permissions: null,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockReport: ModerationReport = {
    id: 'report-1',
    type: ReportType.FLAGGED_CLAIM,
    status: ReportStatus.PENDING,
    priority: ReportPriority.MEDIUM,
    title: 'Suspicious claim',
    description: 'This claim looks suspicious',
    reportedBy: '0xabc',
    reportedUser: null,
    targetId: 'claim-123',
    targetType: 'claim',
    assignedTo: null,
    evidence: null,
    resolution: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    resolvedAt: null,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModerationService,
        {
          provide: getRepositoryToken(ModerationReport),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            findOneBy: jest.fn(),
            findAndCount: jest.fn(),
            find: jest.fn(),
            count: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: AuditTrailService,
          useValue: {
            log: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<ModerationService>(ModerationService);
    reportRepo = module.get<Repository<ModerationReport>>(
      getRepositoryToken(ModerationReport),
    ) as jest.Mocked<Repository<ModerationReport>>;
    auditTrailService = module.get<AuditTrailService>(
      AuditTrailService,
    ) as jest.Mocked<AuditTrailService>;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createReport', () => {
    it('should create a new report', async () => {
      reportRepo.create.mockReturnValue(mockReport);
      reportRepo.save.mockResolvedValue(mockReport);

      const result = await service.createReport(
        {
          type: ReportType.FLAGGED_CLAIM,
          title: 'Suspicious claim',
          description: 'This claim looks suspicious',
          targetId: 'claim-123',
          targetType: 'claim',
        },
        mockAdmin,
      );

      expect(reportRepo.create).toHaveBeenCalled();
      expect(reportRepo.save).toHaveBeenCalled();
      expect(auditTrailService.log).toHaveBeenCalled();
      expect(result).toEqual(mockReport);
    });
  });

  describe('findById', () => {
    it('should return a report by ID', async () => {
      reportRepo.findOneBy.mockResolvedValue(mockReport);

      const result = await service.findById('report-1');

      expect(result).toEqual(mockReport);
    });

    it('should throw NotFoundException if report not found', async () => {
      reportRepo.findOneBy.mockResolvedValue(null);

      await expect(service.findById('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('resolve', () => {
    it('should resolve a report', async () => {
      reportRepo.findOneBy.mockResolvedValue(mockReport);
      const resolved = {
        ...mockReport,
        status: ReportStatus.RESOLVED,
        resolution: {
          action: 'Content removed',
          notes: 'Violates policy',
          resolvedBy: 'admin-1',
          resolvedAt: expect.any(String),
        },
        resolvedAt: expect.any(Date),
      };
      reportRepo.save.mockResolvedValue(resolved);

      const result = await service.resolve(
        'report-1',
        { action: 'Content removed', notes: 'Violates policy' },
        mockAdmin,
      );

      expect(result.status).toBe(ReportStatus.RESOLVED);
      expect(result.resolution).toBeDefined();
      expect(auditTrailService.log).toHaveBeenCalled();
    });
  });

  describe('assign', () => {
    it('should assign a report to a moderator', async () => {
      reportRepo.findOneBy.mockResolvedValue(mockReport);
      reportRepo.save.mockResolvedValue({ ...mockReport, assignedTo: 'mod-1', status: ReportStatus.UNDER_REVIEW });

      const result = await service.assign('report-1', { assigneeId: 'mod-1' }, mockAdmin);

      expect(result.assignedTo).toBe('mod-1');
      expect(result.status).toBe(ReportStatus.UNDER_REVIEW);
    });
  });

  describe('getStats', () => {
    it('should return moderation statistics', async () => {
      reportRepo.count.mockResolvedValue(10);
      reportRepo.find.mockResolvedValue([]);

      const mockQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      } as any;
      reportRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const stats = await service.getStats();

      expect(stats.total).toBe(10);
      expect(stats.byType).toBeDefined();
      expect(stats.byPriority).toBeDefined();
    });
  });
});

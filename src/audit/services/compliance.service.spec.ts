import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ComplianceService } from './compliance.service';
import { AuditLog, AuditActionType, AuditEntityType, AuditSeverity, AuditCategory } from '../entities/audit-log.entity';
import { Repository } from 'typeorm';

describe('ComplianceService', () => {
  let service: ComplianceService;
  let repository: jest.Mocked<Repository<AuditLog>>;

  const mockAuditLog = (overrides: Partial<AuditLog> = {}): AuditLog => ({
    id: 'audit-1',
    eventId: 'evt-1',
    actionType: AuditActionType.CLAIM_CREATED,
    entityType: AuditEntityType.CLAIM,
    entityId: 'claim-1',
    userId: 'user-1',
    walletAddress: '0x123',
    severity: AuditSeverity.LOW,
    category: AuditCategory.OPERATIONS,
    source: 'api',
    requestId: 'req-1',
    description: 'Test log',
    beforeState: null,
    afterState: null,
    metadata: null,
    ipAddress: '203.0.113.0',
    userAgent: 'test-agent',
    correlationId: 'corr-1',
    retentionUntil: null,
    user: null,
    createdAt: new Date('2024-06-15'),
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ComplianceService,
        {
          provide: getRepositoryToken(AuditLog),
          useValue: {
            find: jest.fn(),
            findAndCount: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ComplianceService>(ComplianceService);
    repository = module.get<Repository<AuditLog>>(
      getRepositoryToken(AuditLog),
    ) as jest.Mocked<Repository<AuditLog>>;
  });

  describe('generateReport', () => {
    it('should generate an audit-summary report by default', async () => {
      const mockQueryBuilder = {
        createQueryBuilder: undefined,
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([mockAuditLog()]),
      } as any;

      (repository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      const report = await service.generateReport({});

      expect(report.type).toBe('audit-summary');
      expect(report.totalRecords).toBe(1);
      expect(report.summary.total).toBe(1);
      expect(report.dateRange.start).toBeDefined();
      expect(report.dateRange.end).toBeDefined();
    });

    it('should generate admin-activity report', async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([mockAuditLog()]),
      } as any;

      (repository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      const report = await service.generateReport({ type: 'admin-activity' });

      expect(report.type).toBe('admin-activity');
      expect(report.title).toContain('Administrator');
    });

    it('should generate login-history report', async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([mockAuditLog()]),
      } as any;

      (repository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      const report = await service.generateReport({ type: 'login-history' });

      expect(report.type).toBe('login-history');
    });

    it('should generate security-incidents report', async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([mockAuditLog()]),
      } as any;

      (repository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      const report = await service.generateReport({ type: 'security-incidents' });

      expect(report.type).toBe('security-incidents');
    });

    it('should filter by date range', async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      } as any;

      (repository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      await service.generateReport({
        startDate: '2024-01-01',
        endDate: '2024-12-31',
      });

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'audit.createdAt BETWEEN :startDate AND :endDate',
        expect.objectContaining({
          startDate: expect.any(Date),
          endDate: expect.any(Date),
        }),
      );
    });
  });

  describe('exportAuditLogs', () => {
    it('should export logs as JSON by default', async () => {
      (repository.find as jest.Mock).mockResolvedValue([mockAuditLog()]);

      const result = await service.exportAuditLogs({});

      expect(result.format).toBe('application/json');
      expect(result.filename).toContain('audit-export');
      expect(Array.isArray(result.data)).toBe(true);
    });

    it('should export logs as CSV when requested', async () => {
      (repository.find as jest.Mock).mockResolvedValue([mockAuditLog()]);

      const result = await service.exportAuditLogs({ format: 'csv' });

      expect(result.format).toBe('text/csv');
      expect(result.filename).toContain('.csv');
      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('eventId');
      expect(result.data).toContain('evt-1');
    });
  });

  describe('getCategorySummary', () => {
    it('should return counts grouped by category', async () => {
      const mockQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { category: 'OPERATIONS', count: '20' },
          { category: 'SECURITY', count: '5' },
        ]),
      } as any;

      (repository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      const summary = await service.getCategorySummary(30);

      expect(summary).toEqual({
        OPERATIONS: 20,
        SECURITY: 5,
      });
    });
  });

  describe('getDailyActivity', () => {
    it('should return daily activity counts', async () => {
      const mockQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { date: '2024-06-15', count: '10' },
          { date: '2024-06-16', count: '5' },
        ]),
      } as any;

      (repository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      const activity = await service.getDailyActivity(7);

      expect(activity).toHaveLength(2);
      expect(activity[0]).toEqual({ date: '2024-06-15', count: 10 });
    });
  });
});

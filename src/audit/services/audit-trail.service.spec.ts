/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { AuditTrailService } from './audit-trail.service';
import { AuditLog, AuditActionType, AuditEntityType, AuditSeverity, AuditCategory } from '../entities/audit-log.entity';
import { AuditChainState } from '../entities/audit-chain-state.entity';
import { Repository } from 'typeorm';
import { REQUEST } from '@nestjs/core';
import { AuditQueueService } from './audit-queue.service';
import { AuditMetricsService } from './audit-metrics.service';
import { TransactionRunner } from '../../database/transaction.runner';
import { computeAuditRecordHash } from '../utils/integrity';

interface MockRequestType {
  headers: Record<string, string>;
  ip: string | undefined;
  socket: { remoteAddress: string | undefined };
  get: jest.Mock<string | undefined, [string]>;
}

describe('AuditTrailService', () => {
  let service: AuditTrailService;
  let repository: jest.Mocked<Repository<AuditLog>>;
  let chainStateRepo: any;
  let queueService: jest.Mocked<AuditQueueService>;
  let metricsService: jest.Mocked<AuditMetricsService>;
  let mockRequest: MockRequestType;
  let chainState: { id: number; lastHash: string | null; lastSequence: number };

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
    source: 'api:localhost',
    requestId: 'req-1',
    description: 'Test audit log',
    beforeState: null,
    afterState: null,
    metadata: null,
    ipAddress: '203.0.113.0',
    userAgent: 'test-agent',
    correlationId: 'corr-1',
    retentionUntil: null,
    integrityHash: null,
    previousHash: null,
    chainSequence: null,
    archived: false,
    user: null,
    createdAt: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    mockRequest = {
      headers: {},
      ip: undefined,
      socket: { remoteAddress: undefined },
      get: jest.fn<string | undefined, [string]>(),
    };

    queueService = {
      enqueue: jest.fn(),
      enqueueBatch: jest.fn(),
      getQueueStats: jest.fn(),
    } as unknown as jest.Mocked<AuditQueueService>;

    metricsService = {
      incrementFailedWrite: jest.fn(),
    } as unknown as jest.Mocked<AuditMetricsService>;

    // Chain state starts at genesis; `save` mutates this fixture like a
    // real single-row table would, so tests can assert on it across calls.
    chainState = { id: 1, lastHash: null, lastSequence: 0 };
    chainStateRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockImplementation(async () => ({ ...chainState })),
      }),
      save: jest.fn().mockImplementation(async (state: typeof chainState) => {
        chainState = { ...state };
        return chainState;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditTrailService,
        {
          provide: getRepositoryToken(AuditLog),
          useValue: {
            create: jest.fn((input) => ({ ...input })),
            save: jest.fn(async (entity) => entity),
            find: jest.fn(),
            findAndCount: jest.fn(),
            findOne: jest.fn(),
            count: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: AuditQueueService,
          useValue: queueService,
        },
        {
          provide: AuditMetricsService,
          useValue: metricsService,
        },
        {
          provide: TransactionRunner,
          useValue: {
            run: jest.fn(async (callback: any) =>
              callback({
                getRepository: (entity: any) =>
                  entity === AuditChainState ? chainStateRepo : repository,
              }),
            ),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'AUDIT_HASH_SECRET') return 'test-secret';
              if (key === 'NODE_ENV') return 'test';
              return undefined;
            }),
          },
        },
        {
          provide: REQUEST,
          useValue: mockRequest,
        },
      ],
    }).compile();

    service = module.get<AuditTrailService>(AuditTrailService);
    repository = module.get<Repository<AuditLog>>(
      getRepositoryToken(AuditLog),
    ) as jest.Mocked<Repository<AuditLog>>;
  });

  describe('log', () => {
    it('should create and save a chained audit log entry', async () => {
      const input = {
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'claim-1',
        userId: 'user-1',
        description: 'Claim created',
      };

      await service.log(input);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: input.actionType,
          entityType: input.entityType,
          entityId: input.entityId,
          userId: input.userId,
          description: input.description,
          severity: AuditSeverity.LOW,
          category: AuditCategory.OPERATIONS,
          previousHash: null,
          chainSequence: 1,
        }),
      );
      expect(repository.save).toHaveBeenCalled();
      // The chain tip must advance so the next write links to this one.
      expect(chainState.lastSequence).toBe(1);
      expect(chainState.lastHash).toEqual(expect.any(String));
    });

    it('should use provided severity and category', async () => {
      const input = {
        actionType: AuditActionType.LOGIN_FAILED,
        entityType: AuditEntityType.USER,
        entityId: 'user-1',
        severity: AuditSeverity.HIGH,
        category: AuditCategory.AUTHENTICATION,
      };

      await service.log(input);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: AuditSeverity.HIGH,
          category: AuditCategory.AUTHENTICATION,
        }),
      );
    });

    it('should not throw when the write fails, and should record it as a metric instead of swallowing it silently', async () => {
      (repository.save as jest.Mock).mockRejectedValue(new Error('DB error'));

      await expect(service.log({
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'claim-1',
      })).resolves.toBeUndefined();

      expect(metricsService.incrementFailedWrite).toHaveBeenCalledTimes(1);
    });

    it('should chain a second record to the first', async () => {
      await service.log({
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'claim-1',
      });
      const firstHash = chainState.lastHash;

      await service.log({
        actionType: AuditActionType.CLAIM_UPDATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'claim-1',
      });

      expect(repository.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ previousHash: firstHash, chainSequence: 2 }),
      );
      expect(chainState.lastSequence).toBe(2);
      expect(chainState.lastHash).not.toEqual(firstHash);
    });
  });

  describe('logBatch', () => {
    it('should create and save multiple chained audit logs in one lock', async () => {
      const inputs = [
        {
          actionType: AuditActionType.CLAIM_CREATED,
          entityType: AuditEntityType.CLAIM,
          entityId: 'claim-1',
          userId: 'user-1',
        },
        {
          actionType: AuditActionType.CLAIM_UPDATED,
          entityType: AuditEntityType.CLAIM,
          entityId: 'claim-1',
          userId: 'user-2',
        },
      ];

      await service.logBatch(inputs);

      expect(repository.create).toHaveBeenCalledTimes(2);
      expect(repository.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ previousHash: null, chainSequence: 1 }),
      );
      expect(repository.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ chainSequence: 2 }),
      );
      expect(chainStateRepo.save).toHaveBeenCalledTimes(1);
      expect(chainState.lastSequence).toBe(2);
    });
  });

  describe('persistChainedRecord / verifyChain', () => {
    it('detects a tampered record via verifyIntegrity', async () => {
      let savedRecord: any;
      (repository.save as jest.Mock).mockImplementation(async (entity: any) => {
        savedRecord = entity;
        return entity;
      });

      await service.persistChainedRecord({
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'claim-1',
      } as any);

      (repository.findOne as jest.Mock).mockResolvedValue(savedRecord);

      const before = await service.verifyIntegrity(savedRecord.id);
      expect(before.valid).toBe(true);

      // Simulate direct DB tampering with no knowledge of the HMAC secret.
      (repository.findOne as jest.Mock).mockResolvedValue({
        ...savedRecord,
        description: 'tampered',
      });
      const after = await service.verifyIntegrity(savedRecord.id);
      expect(after.valid).toBe(false);
      expect(after.reason).toBe('hash_mismatch');
    });

    it('verifyChain reports valid for an intact chain', async () => {
      const records: AuditLog[] = [];
      (repository.save as jest.Mock).mockImplementation(async (entity: any) => {
        records.push(entity);
        return entity;
      });

      await service.persistChainedRecord({
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'claim-1',
      } as any);
      await service.persistChainedRecord({
        actionType: AuditActionType.CLAIM_UPDATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'claim-1',
      } as any);

      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn()
          .mockResolvedValueOnce(records)
          .mockResolvedValueOnce([]),
      };
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.verifyChain();
      expect(result.valid).toBe(true);
      expect(result.recordsChecked).toBe(2);
    });

    it('verifyChain reports the broken link when a record is altered after being chained', async () => {
      const records: AuditLog[] = [];
      (repository.save as jest.Mock).mockImplementation(async (entity: any) => {
        records.push(entity);
        return entity;
      });

      await service.persistChainedRecord({
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'claim-1',
      } as any);
      await service.persistChainedRecord({
        actionType: AuditActionType.CLAIM_UPDATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'claim-1',
      } as any);

      // Tamper with the first record's content after the fact, exactly
      // what a hash chain (as opposed to a per-row hash) is meant to
      // catch even though only the first record was touched.
      records[0].description = 'tampered after the fact';

      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn()
          .mockResolvedValueOnce(records)
          .mockResolvedValueOnce([]),
      };
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.verifyChain();
      expect(result.valid).toBe(false);
      expect(result.brokenAt?.id).toBe(records[0].id);
    });
  });

  describe('logAsync', () => {
    it('should enqueue audit log to the queue', async () => {
      const input = {
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'claim-1',
      };

      await service.logAsync(input);

      expect(queueService.enqueue).toHaveBeenCalledWith(input);
    });
  });

  describe('query', () => {
    it('should return paginated results with default filters', async () => {
      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[mockAuditLog()], 1]),
      } as any;

      (repository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      const result = await service.query({});

      expect(result.logs).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(50);
      expect(result.totalPages).toBe(1);
    });

    it('should apply all filters correctly', async () => {
      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      } as any;

      (repository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      await service.query({
        entityType: AuditEntityType.CLAIM,
        actionType: AuditActionType.CLAIM_CREATED,
        severity: AuditSeverity.HIGH,
        category: AuditCategory.SECURITY,
        userId: 'user-1',
        source: 'api',
        requestId: 'req-1',
        correlationId: 'corr-1',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        search: 'test',
        page: 2,
        limit: 25,
      });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'audit.entityType = :entityType', { entityType: AuditEntityType.CLAIM },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'audit.severity = :severity', { severity: AuditSeverity.HIGH },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'audit.category = :category', { category: AuditCategory.SECURITY },
      );
      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(25);
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(25);
    });
  });

  describe('getEntityAuditLogs', () => {
    it('should return logs for a specific entity', async () => {
      const logs = [mockAuditLog()];
      (repository.find as jest.Mock).mockResolvedValue(logs);

      const result = await service.getEntityAuditLogs(
        AuditEntityType.CLAIM,
        'claim-1',
      );

      expect(repository.find).toHaveBeenCalledWith({
        where: { entityType: AuditEntityType.CLAIM, entityId: 'claim-1' },
        order: { createdAt: 'DESC' },
        relations: ['user'],
      });
      expect(result).toEqual(logs);
    });
  });

  describe('getUserAuditLogs', () => {
    it('should return paginated user logs', async () => {
      const logs = [mockAuditLog()];
      (repository.findAndCount as jest.Mock).mockResolvedValue([logs, 1]);

      const result = await service.getUserAuditLogs('user-1', 50, 0);

      expect(result.logs).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe('getAuditLogsByEventId', () => {
    it('should return log by event ID', async () => {
      const log = mockAuditLog();
      (repository.findOne as jest.Mock).mockResolvedValue(log);

      const result = await service.getAuditLogsByEventId('evt-1');

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { eventId: 'evt-1' },
        relations: ['user'],
      });
      expect(result).toEqual(log);
    });
  });

  describe('getStorageStats', () => {
    it('should return storage statistics', async () => {
      (repository.count as jest.Mock).mockResolvedValue(100);

      const oldestQueryBuilder = {
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(mockAuditLog({ createdAt: new Date('2024-01-01') })),
      } as any;

      const newestQueryBuilder = {
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(mockAuditLog({ createdAt: new Date('2024-06-15') })),
      } as any;

      (repository.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(oldestQueryBuilder)
        .mockReturnValueOnce(newestQueryBuilder);

      const stats = await service.getStorageStats();

      expect(stats.totalRecords).toBe(100);
      expect(stats.oldestRecord).toBeDefined();
      expect(stats.newestRecord).toBeDefined();
    });
  });

  describe('deleteOldLogs', () => {
    it('should delete logs older than cutoff respecting legal hold', async () => {
      const mockQueryBuilder = {
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 4 }),
      } as any;

      (repository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      const deleted = await service.deleteOldLogs(90);

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'audit.createdAt < :cutoff AND audit.retentionUntil IS NULL',
        expect.objectContaining({ cutoff: expect.any(Date) }),
      );
      expect(deleted).toBe(4);
    });
  });

  describe('getChangeHistory', () => {
    it('should compute changes between before and after states', async () => {
      const log = mockAuditLog({
        beforeState: { status: 'open', value: 100 },
        afterState: { status: 'resolved', value: 100 },
      });

      (repository.find as jest.Mock).mockResolvedValue([log]);

      const history = await service.getChangeHistory(AuditEntityType.CLAIM, 'claim-1');

      expect(history).toHaveLength(1);
      expect(history[0].changes).toEqual({
        status: { before: 'open', after: 'resolved' },
      });
    });
  });

  describe('getAuditSummary', () => {
    it('should return summary grouped by action type', async () => {
      const mockQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { actionType: 'CLAIM_CREATED', count: '10' },
          { actionType: 'CLAIM_RESOLVED', count: '5' },
        ]),
      } as any;

      (repository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      const summary = await service.getAuditSummary(AuditEntityType.CLAIM, 7);

      expect(summary).toEqual({
        CLAIM_CREATED: 10,
        CLAIM_RESOLVED: 5,
      });
    });
  });

  describe('IP Security and Masking', () => {
    it('should store masked IP from request', async () => {
      mockRequest.ip = '203.0.113.45';
      const input = {
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'test-123',
      };

      await service.log(input);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '203.0.113.0',
        }),
      );
    });
  });

  describe('fail-closed HMAC secret', () => {
    it('throws at startup in production when AUDIT_HASH_SECRET is not configured', async () => {
      const configService = {
        get: jest.fn((key: string) => {
          if (key === 'AUDIT_HASH_SECRET') return undefined;
          if (key === 'NODE_ENV') return 'production';
          return undefined;
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AuditTrailService,
          { provide: getRepositoryToken(AuditLog), useValue: repository },
          { provide: AuditQueueService, useValue: queueService },
          { provide: AuditMetricsService, useValue: metricsService },
          { provide: TransactionRunner, useValue: { run: jest.fn() } },
          { provide: ConfigService, useValue: configService },
          { provide: REQUEST, useValue: mockRequest },
        ],
      }).compile();

      const prodService = module.get<AuditTrailService>(AuditTrailService);
      expect(() => prodService.onModuleInit()).toThrow(/AUDIT_HASH_SECRET/);
    });
  });
});

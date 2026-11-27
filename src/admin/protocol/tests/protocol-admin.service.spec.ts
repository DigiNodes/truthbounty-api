import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Admin } from '../../entities/admin.entity';
import { AuditLog } from '../../../audit/entities/audit-log.entity';
import { Claim } from '../../../claims/entities/claim.entity';
import { Dispute } from '../../../dispute/entities/dispute.entity';
import { ProtocolAdminService } from '../protocol-admin.service';
import { AuditTrailService } from '../../../audit/services/audit-trail.service';
import { FeatureFlagsService } from '../../../feature-flags/feature-flags.service';
import { ConfigurationService } from '../../../feature-flags/configuration.service';
import { JobsService } from '../../../jobs/jobs.service';
import { RedisService } from '../../../redis/redis.service';
import { QueueName } from '../../../jobs/jobs.types';
import {
  ServiceType,
  QueueAction,
  ServiceAction,
} from '../dto/service-control.dto';
import {
  EmergencyAction,
  ExecuteEmergencyActionDto,
} from '../dto/emergency.dto';
import { SetMaintenanceModeDto } from '../dto/maintenance.dto';

describe('ProtocolAdminService', () => {
  let service: ProtocolAdminService;

  const mockAdminRepo = {
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    findAndCount: jest.fn(),
    count: jest.fn(),
  };

  const mockAuditLogRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    findAndCount: jest.fn(),
    count: jest.fn().mockResolvedValue(42),
  };

  const mockClaimRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    findAndCount: jest.fn(),
    count: jest.fn(),
  };

  const mockDisputeRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    findAndCount: jest.fn(),
    count: jest.fn(),
  };

  const mockDataSource = {
    query: jest.fn().mockResolvedValue([{ count: 100 }]),
  };

  const mockAuditTrailService = {
    log: jest.fn().mockResolvedValue(undefined),
  };

  const mockFeatureFlagsService = {
    findAll: jest.fn().mockResolvedValue([]),
    evaluate: jest.fn().mockResolvedValue({ enabled: true }),
  };

  const mockConfigService = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue({ id: 'cfg-1', key: 'test-key' }),
    findAll: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue({ id: 'cfg-1' }),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  const mockJobsService = {
    getAllQueueMetrics: jest.fn().mockResolvedValue([
      {
        name: QueueName.DEFAULT,
        waiting: 5,
        active: 2,
        completed: 100,
        failed: 3,
        delayed: 1,
        paused: false,
      },
      {
        name: QueueName.NOTIFICATIONS,
        waiting: 0,
        active: 0,
        completed: 50,
        failed: 1,
        delayed: 0,
        paused: false,
      },
    ]),
    pauseQueue: jest.fn().mockResolvedValue(undefined),
    resumeQueue: jest.fn().mockResolvedValue(undefined),
    retryFailed: jest.fn().mockResolvedValue(3),
  };

  const mockRedisService = {
    flushall: jest.fn().mockResolvedValue(true),
  };

  const mockDefaultQueue = { drain: jest.fn().mockResolvedValue(undefined) };
  const mockNotificationsQueue = {
    drain: jest.fn().mockResolvedValue(undefined),
  };
  const mockBlockchainQueue = {
    drain: jest.fn().mockResolvedValue(undefined),
  };
  const mockAnalyticsQueue = { drain: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProtocolAdminService,
        { provide: getRepositoryToken(Admin), useValue: mockAdminRepo },
        { provide: getRepositoryToken(AuditLog), useValue: mockAuditLogRepo },
        { provide: getRepositoryToken(Claim), useValue: mockClaimRepo },
        { provide: getRepositoryToken(Dispute), useValue: mockDisputeRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: AuditTrailService, useValue: mockAuditTrailService },
        { provide: FeatureFlagsService, useValue: mockFeatureFlagsService },
        { provide: ConfigurationService, useValue: mockConfigService },
        { provide: JobsService, useValue: mockJobsService },
        { provide: RedisService, useValue: mockRedisService },
        {
          provide: getQueueToken(QueueName.DEFAULT),
          useValue: mockDefaultQueue,
        },
        {
          provide: getQueueToken(QueueName.NOTIFICATIONS),
          useValue: mockNotificationsQueue,
        },
        {
          provide: getQueueToken(QueueName.BLOCKCHAIN),
          useValue: mockBlockchainQueue,
        },
        {
          provide: getQueueToken(QueueName.ANALYTICS),
          useValue: mockAnalyticsQueue,
        },
      ],
    }).compile();

    service = module.get<ProtocolAdminService>(ProtocolAdminService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ──────────────────────────────────────────────
  //  SYSTEM STATUS TESTS
  // ──────────────────────────────────────────────

  describe('getSystemStatus', () => {
    it('should return system status with defaults', async () => {
      const status = await service.getSystemStatus();

      expect(status.maintenanceMode).toBe(false);
      expect(status.emergencyActive).toBe(false);
      expect(status.activeEmergencies).toEqual([]);
      expect(status.queuesOperational).toBe(true);
      expect(status.notificationsEnabled).toBe(true);
      expect(status.integrationsOperational).toBe(true);
      expect(status.environment).toBeDefined();
      expect(status.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getOperationalStats', () => {
    beforeEach(() => {
      // Set up default mock return values
      mockAdminRepo.count.mockResolvedValue(5);
      mockClaimRepo.count.mockResolvedValue(10);
      mockDisputeRepo.count.mockResolvedValue(3);
      mockAuditLogRepo.count.mockResolvedValue(42);
      mockDataSource.query.mockResolvedValue([{ count: 100 }]);
    });

    it('should return aggregated operational statistics with real metrics', async () => {
      // Configure specific counts for different claim states
      mockClaimRepo.count
        .mockResolvedValueOnce(100) // totalClaims
        .mockResolvedValueOnce(25) // pendingClaims (finalized = false)
        .mockResolvedValueOnce(75); // finalizedClaims (finalized = true)

      mockDisputeRepo.count.mockResolvedValueOnce(15); // totalDisputes
      
      mockAdminRepo.count
        .mockResolvedValueOnce(10) // totalAdmins
        .mockResolvedValueOnce(7); // activeAdmins

      const stats = await service.getOperationalStats();

      expect(stats.totalUsers).toBe(100);
      expect(stats.totalClaims).toBe(100);
      expect(stats.totalDisputes).toBe(15);
      expect(stats.totalAdmins).toBe(10);
      expect(stats.activeAdmins).toBe(7);
      expect(stats.pendingClaims).toBe(25);
      expect(stats.finalizedClaims).toBe(75);
      expect(stats.auditLogCount).toBe(42);
      expect(stats.queueMetrics).toHaveProperty('totalWaiting');
      expect(stats.queueMetrics).toHaveProperty('totalActive');
      expect(stats.queueMetrics).toHaveProperty('totalFailed');
      expect(stats.queueMetrics).toHaveProperty('totalCompleted');
      expect(stats.environment).toBeDefined();
      expect(stats.timestamp).toBeDefined();
      expect(stats.metadata).toBeDefined();
      expect(stats.metadata.claims).toBeDefined();
      expect(stats.metadata.disputes).toBeDefined();
      expect(stats.metadata.admins).toBeDefined();
      expect(stats.metadata.overall).toBeDefined();
    });

    it('should query database for all required counts', async () => {
      await service.getOperationalStats();

      expect(mockDataSource.query).toHaveBeenCalled();
      expect(mockAdminRepo.count).toHaveBeenCalled();
      expect(mockClaimRepo.count).toHaveBeenCalled();
      expect(mockDisputeRepo.count).toHaveBeenCalled();
      expect(mockAuditLogRepo.count).toHaveBeenCalled();
    });

    it('should return healthy metadata when all queries succeed', async () => {
      mockClaimRepo.count.mockResolvedValue(50);
      mockDisputeRepo.count.mockResolvedValue(10);
      mockAdminRepo.count.mockResolvedValue(5);

      const stats = await service.getOperationalStats();

      expect(stats.metadata.overall.available).toBe(true);
      expect(stats.metadata.overall.sourceStatus).toBe('healthy');
      expect(stats.metadata.overall.reason).toBeUndefined();
      expect(stats.metadata.claims.available).toBe(true);
      expect(stats.metadata.claims.sourceStatus).toBe('healthy');
      expect(stats.metadata.disputes.available).toBe(true);
      expect(stats.metadata.disputes.sourceStatus).toBe('healthy');
      expect(stats.metadata.admins.available).toBe(true);
      expect(stats.metadata.admins.sourceStatus).toBe('healthy');
    });

    it('should return degraded metadata when some queries fail', async () => {
      // Simulate partial failure: claims fail, but disputes succeed
      mockClaimRepo.count.mockRejectedValue(new Error('Database error'));
      mockDisputeRepo.count.mockResolvedValue(10);
      mockAdminRepo.count.mockResolvedValue(5);

      const stats = await service.getOperationalStats();

      expect(stats.metadata.overall.available).toBe(true);
      expect(stats.metadata.overall.sourceStatus).toBe('degraded');
      expect(stats.metadata.overall.reason).toContain('Some metrics');
      expect(stats.metadata.claims.available).toBe(false);
      expect(stats.metadata.claims.sourceStatus).toBe('unavailable');
      expect(stats.metadata.disputes.available).toBe(true);
      expect(stats.metadata.disputes.sourceStatus).toBe('healthy');
      expect(stats.totalClaims).toBe(0); // Returns 0 on error
      expect(stats.totalDisputes).toBe(10); // Returns actual value
    });

    it('should return unavailable metadata when all queries fail', async () => {
      // Simulate complete failure
      mockClaimRepo.count.mockRejectedValue(new Error('Database down'));
      mockDisputeRepo.count.mockRejectedValue(new Error('Database down'));
      mockAdminRepo.count.mockRejectedValue(new Error('Database down'));
      mockAuditLogRepo.count.mockRejectedValue(new Error('Database down'));
      mockDataSource.query.mockRejectedValue(new Error('Database down'));

      const stats = await service.getOperationalStats();

      expect(stats.metadata.overall.available).toBe(false);
      expect(stats.metadata.overall.sourceStatus).toBe('unavailable');
      expect(stats.totalClaims).toBe(0);
      expect(stats.totalDisputes).toBe(0);
      expect(stats.totalAdmins).toBe(0);
      expect(stats.activeAdmins).toBe(0);
    });

    it('should correctly count pending vs finalized claims', async () => {
      // 30 pending (not finalized), 70 finalized
      mockClaimRepo.count
        .mockResolvedValueOnce(100) // totalClaims
        .mockResolvedValueOnce(30) // pendingClaims (finalized = false)
        .mockResolvedValueOnce(70); // finalizedClaims (finalized = true)

      const stats = await service.getOperationalStats();

      expect(stats.totalClaims).toBe(100);
      expect(stats.pendingClaims).toBe(30);
      expect(stats.finalizedClaims).toBe(70);
      
      // Verify correct where clauses were used
      expect(mockClaimRepo.count).toHaveBeenCalledWith();
      expect(mockClaimRepo.count).toHaveBeenCalledWith({
        where: { finalized: false },
      });
      expect(mockClaimRepo.count).toHaveBeenCalledWith({
        where: { finalized: true },
      });
    });

    it('should correctly count active admins', async () => {
      mockAdminRepo.count
        .mockResolvedValueOnce(20) // totalAdmins
        .mockResolvedValueOnce(15); // activeAdmins (isActive = true)

      const stats = await service.getOperationalStats();

      expect(stats.totalAdmins).toBe(20);
      expect(stats.activeAdmins).toBe(15);
      
      // Verify correct where clause for active admins
      expect(mockAdminRepo.count).toHaveBeenCalledWith();
      expect(mockAdminRepo.count).toHaveBeenCalledWith({
        where: { isActive: true },
      });
    });

    it('should return true zero when dataset is empty and source is healthy', async () => {
      // Empty dataset scenario
      mockClaimRepo.count.mockResolvedValue(0);
      mockDisputeRepo.count.mockResolvedValue(0);
      mockAdminRepo.count.mockResolvedValue(0);

      const stats = await service.getOperationalStats();

      expect(stats.totalClaims).toBe(0);
      expect(stats.totalDisputes).toBe(0);
      expect(stats.totalAdmins).toBe(0);
      expect(stats.activeAdmins).toBe(0);
      expect(stats.pendingClaims).toBe(0);
      expect(stats.finalizedClaims).toBe(0);
      // Metadata should still show healthy since queries succeeded
      expect(stats.metadata.overall.sourceStatus).toBe('healthy');
      expect(stats.metadata.claims.sourceStatus).toBe('healthy');
    });

    it('should handle large datasets efficiently with bounded queries', async () => {
      // Simulate large dataset counts
      mockClaimRepo.count
        .mockResolvedValueOnce(1000000) // totalClaims
        .mockResolvedValueOnce(250000) // pendingClaims
        .mockResolvedValueOnce(750000); // finalizedClaims

      mockDisputeRepo.count.mockResolvedValueOnce(50000);
      mockAdminRepo.count
        .mockResolvedValueOnce(1000)
        .mockResolvedValueOnce(800);

      const stats = await service.getOperationalStats();

      expect(stats.totalClaims).toBe(1000000);
      expect(stats.pendingClaims).toBe(250000);
      expect(stats.finalizedClaims).toBe(750000);
      expect(stats.totalDisputes).toBe(50000);
      expect(stats.metadata.overall.sourceStatus).toBe('healthy');
    });

    it('should include timestamp in metadata', async () => {
      const beforeTime = new Date().toISOString();
      const stats = await service.getOperationalStats();
      const afterTime = new Date().toISOString();

      expect(stats.timestamp).toBeDefined();
      expect(stats.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(stats.timestamp >= beforeTime).toBe(true);
      expect(stats.timestamp <= afterTime).toBe(true);
      
      expect(stats.metadata.overall.lastUpdated).toBe(stats.timestamp);
      expect(stats.metadata.claims.lastUpdated).toBe(stats.timestamp);
      expect(stats.metadata.disputes.lastUpdated).toBe(stats.timestamp);
      expect(stats.metadata.admins.lastUpdated).toBe(stats.timestamp);
    });
  });

  // ──────────────────────────────────────────────
  //  MAINTENANCE MODE TESTS
  // ──────────────────────────────────────────────

  describe('setMaintenanceMode', () => {
    it('should enable maintenance mode', async () => {
      const dto: SetMaintenanceModeDto = {
        enabled: true,
        reason: 'Scheduled upgrade',
      };

      const result = await service.setMaintenanceMode(dto, 'admin-1');

      expect(result.active).toBe(true);
      expect(result.reason).toBe('Scheduled upgrade');
      expect(result.startedAt).toBeDefined();
      expect(mockAuditTrailService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'MAINTENANCE_MODE_ENABLED',
          description: expect.stringContaining('Scheduled upgrade'),
        }),
      );
    });

    it('should disable maintenance mode', async () => {
      // Enable first
      await service.setMaintenanceMode(
        { enabled: true, reason: 'test' },
        'admin-1',
      );

      const dto: SetMaintenanceModeDto = { enabled: false };
      const result = await service.setMaintenanceMode(dto, 'admin-1');

      expect(result.active).toBe(false);
      expect(mockAuditTrailService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'MAINTENANCE_MODE_DISABLED',
        }),
      );
    });

    it('should set scheduled end time', async () => {
      const dto: SetMaintenanceModeDto = {
        enabled: true,
        scheduledEnd: '2026-08-01T00:00:00Z',
      };

      const result = await service.setMaintenanceMode(dto, 'admin-1');

      expect(result.scheduledEnd).toBe('2026-08-01T00:00:00Z');
    });
  });

  describe('scheduleMaintenance', () => {
    it('should create a maintenance schedule', async () => {
      const schedule = await service.scheduleMaintenance(
        {
          startTime: '2026-08-01T02:00:00Z',
          description: 'Database upgrade',
          affectedServices: ['database', 'api'],
        },
        'admin-1',
      );

      expect(schedule.id).toBeDefined();
      expect(schedule.description).toBe('Database upgrade');
      expect(schedule.status).toBe('scheduled');
      expect(schedule.affectedServices).toEqual(['database', 'api']);
      expect(mockAuditTrailService.log).toHaveBeenCalled();
    });
  });

  describe('cancelMaintenance', () => {
    it('should cancel a scheduled maintenance', async () => {
      const schedule = await service.scheduleMaintenance(
        {
          startTime: '2026-08-01T02:00:00Z',
          description: 'Database upgrade',
        },
        'admin-1',
      );

      await service.cancelMaintenance(schedule.id, 'admin-1');

      const status = await service.getMaintenanceStatus();
      expect(
        status.scheduledMaintenance.find((s) => s.id === schedule.id),
      ).toBeUndefined();
    });

    it('should throw NotFoundException for unknown schedule', async () => {
      await expect(
        service.cancelMaintenance('nonexistent-id', 'admin-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────
  //  SERVICE MANAGEMENT TESTS
  // ──────────────────────────────────────────────

  describe('controlService', () => {
    it('should pause a queue', async () => {
      const result = await service.controlService(
        {
          serviceType: ServiceType.QUEUE,
          action: QueueAction.PAUSE,
          queueName: QueueName.DEFAULT,
        },
        'admin-1',
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe(QueueAction.PAUSE);
      expect(result.serviceType).toBe(ServiceType.QUEUE);
      expect(mockJobsService.pauseQueue).toHaveBeenCalledWith(
        QueueName.DEFAULT,
      );
      expect(mockAuditTrailService.log).toHaveBeenCalled();
    });

    it('should resume a queue', async () => {
      const result = await service.controlService(
        {
          serviceType: ServiceType.QUEUE,
          action: QueueAction.RESUME,
        },
        'admin-1',
      );

      expect(result.success).toBe(true);
      expect(mockJobsService.resumeQueue).toHaveBeenCalled();
    });

    it('should retry failed jobs', async () => {
      const result = await service.controlService(
        {
          serviceType: ServiceType.QUEUE,
          action: QueueAction.RETRY_FAILED,
        },
        'admin-1',
      );

      expect(result.success).toBe(true);
      expect(mockJobsService.retryFailed).toHaveBeenCalled();
    });

    it('should suspend notification service', async () => {
      const result = await service.controlService(
        {
          serviceType: ServiceType.NOTIFICATION,
          action: ServiceAction.SUSPEND,
          reason: 'Testing',
        },
        'admin-1',
      );

      expect(result.success).toBe(true);
      expect(mockAuditTrailService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'SERVICE_SUSPENDED',
          description: expect.stringContaining('Testing'),
        }),
      );
    });

    it('should restore notification service', async () => {
      const result = await service.controlService(
        {
          serviceType: ServiceType.NOTIFICATION,
          action: ServiceAction.RESTORE,
        },
        'admin-1',
      );

      expect(result.success).toBe(true);
    });

    it('should invalidate cache', async () => {
      const result = await service.controlService(
        {
          serviceType: ServiceType.CACHE,
          action: ServiceAction.INVALIDATE_CACHE,
        },
        'admin-1',
      );

      expect(result.success).toBe(true);
      expect(mockRedisService.flushall).toHaveBeenCalled();
      expect(mockAuditTrailService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'CACHE_INVALIDATED',
        }),
      );
    });

    it('should return error on unknown service type', async () => {
      const result = await service.controlService(
        {
          serviceType: 'unknown' as ServiceType,
          action: QueueAction.PAUSE,
        },
        'admin-1',
      );

      expect(result.success).toBe(false);
      expect(result.message).toBeDefined();
    });
  });

  describe('getQueueMetrics', () => {
    it('should return metrics for all queues', async () => {
      const result = await service.getQueueMetrics();

      expect(result.queues).toHaveLength(2);
      expect(result.totalWaiting).toBe(5);
      expect(result.totalActive).toBe(2);
      expect(result.totalFailed).toBe(4);
    });
  });

  // ──────────────────────────────────────────────
  //  EMERGENCY OPERATIONS TESTS
  // ──────────────────────────────────────────────

  describe('executeEmergencyAction', () => {
    it('should execute an emergency action', async () => {
      const dto: ExecuteEmergencyActionDto = {
        action: EmergencyAction.PAUSE_ALL_QUEUES,
        reason: 'Critical incident',
      };

      const result = await service.executeEmergencyAction(dto, 'admin-1');

      expect(result.success).toBe(true);
      expect(result.action).toBe(EmergencyAction.PAUSE_ALL_QUEUES);
      expect(result.affectedServices).toContain('queues');
      expect(mockAuditTrailService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'EMERGENCY_ACTION_EXECUTED',
          severity: 'CRITICAL',
          description: expect.stringContaining('Critical incident'),
        }),
      );
    });

    it('should execute action with optional duration', async () => {
      const dto: ExecuteEmergencyActionDto = {
        action: EmergencyAction.DISABLE_NOTIFICATIONS,
        reason: 'Rate limit exceeded',
        durationMinutes: 30,
      };

      const result = await service.executeEmergencyAction(dto, 'admin-1');

      expect(result.success).toBe(true);
    });

    it('should reflect emergency in system status', async () => {
      await service.executeEmergencyAction(
        {
          action: EmergencyAction.SUSPEND_ALL_SERVICES,
          reason: 'Emergency test',
        },
        'admin-1',
      );

      const status = await service.getSystemStatus();
      expect(status.emergencyActive).toBe(true);
      expect(status.activeEmergencies).toContain(
        EmergencyAction.SUSPEND_ALL_SERVICES,
      );
    });
  });

  describe('resolveEmergencyAction', () => {
    it('should resolve an active emergency action', async () => {
      await service.executeEmergencyAction(
        {
          action: EmergencyAction.DISABLE_NOTIFICATIONS,
          reason: 'test',
        },
        'admin-1',
      );

      await service.resolveEmergencyAction(
        EmergencyAction.DISABLE_NOTIFICATIONS,
        'admin-1',
      );

      const status = await service.getSystemStatus();
      expect(status.activeEmergencies).not.toContain(
        EmergencyAction.DISABLE_NOTIFICATIONS,
      );
      expect(mockAuditTrailService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'SERVICE_RESTORED',
        }),
      );
    });

    it('should throw NotFoundException for inactive emergency', async () => {
      await expect(
        service.resolveEmergencyAction(
          EmergencyAction.EMERGENCY_SHUTDOWN,
          'admin-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────
  //  CONFIGURATION MANAGEMENT TESTS
  // ──────────────────────────────────────────────

  describe('setProtocolConfig', () => {
    it('should set a protocol configuration value', async () => {
      const result = await service.setProtocolConfig(
        {
          key: 'test-key',
          value: { setting: 'value' },
          changeReason: 'Test change',
        },
        'admin-1',
      );

      expect(result).toBeDefined();
      expect(mockConfigService.set).toHaveBeenCalledWith(
        'test-key',
        { setting: 'value' },
        undefined,
        'admin-1',
        'Test change',
      );
      expect(mockAuditTrailService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'PROTOCOL_CONFIG_UPDATED',
          description: expect.stringContaining('Test change'),
        }),
      );
    });
  });

  describe('getProtocolConfig', () => {
    it('should get a protocol configuration value', async () => {
      mockConfigService.get.mockResolvedValue({ setting: 'value' });

      const result = await service.getProtocolConfig('test-key');

      expect(result).toEqual({ setting: 'value' });
    });
  });

  // ──────────────────────────────────────────────
  //  AUDIT LOG TESTS
  // ──────────────────────────────────────────────

  describe('getAdminAuditLogs', () => {
    it('should return admin audit logs', async () => {
      mockAuditLogRepo.findAndCount.mockResolvedValue([[{ id: 'log-1' }], 1]);

      const result = await service.getAdminAuditLogs(10, 0);

      expect(result.logs).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe('getProtocolAuditLogs', () => {
    it('should return protocol audit logs', async () => {
      mockAuditLogRepo.findAndCount.mockResolvedValue([
        [{ id: 'log-1' }, { id: 'log-2' }],
        2,
      ]);

      const result = await service.getProtocolAuditLogs(20, 0);

      expect(result.logs).toHaveLength(2);
    });
  });

  // ──────────────────────────────────────────────
  //  MAINTENANCE STATUS TESTS
  // ──────────────────────────────────────────────

  describe('getMaintenanceStatus', () => {
    it('should return empty maintenance when not active', async () => {
      const status = await service.getMaintenanceStatus();

      expect(status.active).toBe(false);
      expect(status.scheduledMaintenance).toEqual([]);
    });

    it('should include scheduled maintenance', async () => {
      await service.scheduleMaintenance(
        {
          startTime: '2026-08-01T02:00:00Z',
          description: 'Scheduled maintenance',
        },
        'admin-1',
      );

      const status = await service.getMaintenanceStatus();
      expect(status.scheduledMaintenance).toHaveLength(1);
      expect(status.scheduledMaintenance[0].description).toBe(
        'Scheduled maintenance',
      );
    });
  });

  // ──────────────────────────────────────────────
  //  FEATURE FLAGS
  // ──────────────────────────────────────────────

  describe('listFeatureFlags', () => {
    it('should list feature flags', async () => {
      const result = await service.listFeatureFlags();

      expect(mockFeatureFlagsService.findAll).toHaveBeenCalled();
      expect(result).toEqual([]);
    });
  });

  describe('evaluateFeatureFlag', () => {
    it('should evaluate a feature flag', async () => {
      const result = await service.evaluateFeatureFlag('test-flag', {
        userId: 'user-1',
      });

      expect(mockFeatureFlagsService.evaluate).toHaveBeenCalledWith(
        'test-flag',
        { userId: 'user-1' },
      );
      expect(result).toEqual({ enabled: true });
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { Repository, DataSource } from 'typeorm';
import { Admin, AdminRole } from '../../entities/admin.entity';
import { AuditLog } from '../../../audit/entities/audit-log.entity';
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
        { provide: DataSource, useValue: mockDataSource },
        { provide: AuditTrailService, useValue: mockAuditTrailService },
        { provide: FeatureFlagsService, useValue: mockFeatureFlagsService },
        { provide: ConfigurationService, useValue: mockConfigService },
        { provide: JobsService, useValue: mockJobsService },
        { provide: RedisService, useValue: mockRedisService },
        { provide: getQueueToken(QueueName.DEFAULT), useValue: mockDefaultQueue },
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
    it('should return aggregated operational statistics', async () => {
      const stats = await service.getOperationalStats();

      expect(stats).toHaveProperty('totalUsers');
      expect(stats).toHaveProperty('totalAdmins');
      expect(stats).toHaveProperty('auditLogCount');
      expect(stats.queueMetrics).toHaveProperty('totalWaiting');
      expect(stats.queueMetrics).toHaveProperty('totalActive');
      expect(stats.queueMetrics).toHaveProperty('totalFailed');
      expect(stats.queueMetrics).toHaveProperty('totalCompleted');
      expect(stats.environment).toBeDefined();
      expect(stats.timestamp).toBeDefined();
    });

    it('should query database for user and admin counts', async () => {
      await service.getOperationalStats();

      expect(mockDataSource.query).toHaveBeenCalled();
      expect(mockAdminRepo.count).toHaveBeenCalled();
      expect(mockAuditLogRepo.count).toHaveBeenCalled();
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
      mockAuditLogRepo.findAndCount.mockResolvedValue([
        [{ id: 'log-1' }],
        1,
      ]);

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

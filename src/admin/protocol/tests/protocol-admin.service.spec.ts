import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Admin } from '../../entities/admin.entity';
import { AuditLog } from '../../../audit/entities/audit-log.entity';
import { OperationalControl } from '../../entities/operational-control.entity';
import { OperationalControlEvent } from '../../entities/operational-control-event.entity';
import { IndexedEvent } from '../../../entities/indexed-event.entity';
import { ProtocolAdminService } from '../protocol-admin.service';
import { OperationalControlReconciler } from '../operational-control-reconciler';
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
  let reconciler: OperationalControlReconciler;

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
    transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) =>
      cb(mockEntityManager),
    ),
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

  let storedControl: any = null;

  const mockControlRepo = {
    findOne: jest.fn(async () => storedControl),
    create: jest.fn((entity) => entity),
    save: jest.fn(async (entity: any) => {
      const persisted = { ...entity, version: (entity.version ?? 0) + 1 };
      Object.assign(entity, persisted);
      storedControl = persisted;
      return persisted;
    }),
  };

  const mockControlEventRepo = {
    create: jest.fn((entity) => entity),
    save: jest.fn(async (entity) => entity),
  };

  const mockIndexedEventRepo = {
    find: jest.fn().mockResolvedValue([]),
    manager: {
      query: jest.fn().mockResolvedValue([]),
    },
  };

  const mockEntityManager = {
    query: jest.fn().mockResolvedValue([]),
    getRepository: jest.fn((entity) => {
      if (entity === OperationalControl) return mockControlRepo;
      if (entity === IndexedEvent) return mockIndexedEventRepo;
      return mockControlEventRepo;
    }),
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
    storedControl = null;
    mockIndexedEventRepo.find.mockResolvedValue([]);
    mockAdminRepo.findOneBy.mockResolvedValue({
      id: 'admin-1',
      role: 'administrator',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProtocolAdminService,
        { provide: getRepositoryToken(Admin), useValue: mockAdminRepo },
        { provide: getRepositoryToken(AuditLog), useValue: mockAuditLogRepo },
        {
          provide: getRepositoryToken(OperationalControl),
          useValue: mockControlRepo,
        },
        {
          provide: getRepositoryToken(OperationalControlEvent),
          useValue: mockControlEventRepo,
        },
        {
          provide: getRepositoryToken(IndexedEvent),
          useValue: mockIndexedEventRepo,
        },
        OperationalControlReconciler,
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
    reconciler = module.get<OperationalControlReconciler>(
      OperationalControlReconciler,
    );
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

      expect(result.scheduledEnd).toBe('2026-08-01T00:00:00.000Z');
    });
  });

  describe('scheduleMaintenance', () => {
    it('should create a maintenance schedule', async () => {
      const schedule = await service.scheduleMaintenance(
        {
          startTime: '2027-08-01T02:00:00Z',
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
          startTime: '2027-08-01T02:00:00Z',
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
          startTime: '2027-08-01T02:00:00Z',
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

  // ──────────────────────────────────────────────
  //  DURABLE OPERATIONAL CONTROLS
  // ──────────────────────────────────────────────

  describe('durable operational controls', () => {
    it('persists maintenance state to the operational_controls row', async () => {
      await service.setMaintenanceMode(
        { enabled: true, reason: 'db failover' },
        'admin-1',
      );

      expect(storedControl).toMatchObject({
        id: 'system',
        maintenanceActive: true,
        maintenanceReason: 'db failover',
      });
      expect(storedControl.updatedBy).toBe('admin-1');
    });

    it('reconciles pre-existing overdue state from the singleton startup hook without a status read', async () => {
      storedControl = {
        id: 'system',
        maintenanceActive: true,
        maintenanceReason: 'persisted',
        maintenanceStartedAt: new Date('2026-01-01T00:00:00Z'),
        maintenanceScheduledEnd: null,
        schedules: [],
        emergencies: {
          disable_notifications: {
            action: EmergencyAction.DISABLE_NOTIFICATIONS,
            reason: 'expired before restart',
            timestamp: new Date(Date.now() - 7200_000).toISOString(),
            expiresAt: Date.now() - 1000,
          },
        },
        services: { notifications: false },
        pendingCanonicalActions: {},
        updatedBy: 'admin-9',
        version: 3,
      };

      await reconciler.onModuleInit();

      expect(storedControl.emergencies).toEqual({});
      const events = mockControlEventRepo.save.mock.calls.map((c) => c[0]);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: 'emergency_expire' }),
        ]),
      );
      expect(mockAdminRepo.count).not.toHaveBeenCalled();
    });

    it('expires emergency actions deterministically during reconcile', async () => {
      storedControl = {
        id: 'system',
        maintenanceActive: false,
        maintenanceReason: null,
        maintenanceStartedAt: null,
        maintenanceScheduledEnd: null,
        schedules: [],
        emergencies: {
          disable_notifications: {
            action: EmergencyAction.DISABLE_NOTIFICATIONS,
            reason: 'old incident',
            timestamp: new Date(Date.now() - 7200_000).toISOString(),
            expiresAt: Date.now() - 1000,
          },
        },
        services: {},
        pendingCanonicalActions: {},
        updatedBy: 'admin-9',
        version: 1,
      };

      const status = await service.getSystemStatus();

      expect(status.emergencyActive).toBe(false);
      expect(status.activeEmergencies).toEqual([]);
      expect(status.notificationsEnabled).toBe(true);
      expect(storedControl.emergencies).toEqual({});
    });

    it('transitions overdue schedules to active/completed on reconcile', async () => {
      const past = new Date(Date.now() - 3600_000).toISOString();
      const future = new Date(Date.now() + 3600_000).toISOString();
      storedControl = {
        id: 'system',
        maintenanceActive: false,
        maintenanceReason: null,
        maintenanceStartedAt: null,
        maintenanceScheduledEnd: null,
        schedules: [
          {
            id: 's1',
            description: 'started during downtime',
            startTime: past,
            status: 'scheduled',
          },
          {
            id: 's2',
            description: 'ended during downtime',
            startTime: past,
            endTime: past,
            status: 'active',
          },
          {
            id: 's3',
            description: 'upcoming',
            startTime: future,
            status: 'scheduled',
          },
        ],
        emergencies: {},
        services: {},
        pendingCanonicalActions: {},
        updatedBy: null,
        version: 1,
      };

      const status = await service.getMaintenanceStatus();
      const byId = Object.fromEntries(
        status.scheduledMaintenance.map((s) => [s.id, s.status]),
      );

      expect(byId.s1).toBe('active');
      expect(byId.s3).toBe('scheduled');
      expect(
        storedControl.schedules.find((s: any) => s.id === 's2').status,
      ).toBe('completed');
    });

    it('rejects control mutations from unauthorized roles', async () => {
      mockAdminRepo.findOneBy.mockResolvedValue({
        id: 'auditor-1',
        role: 'auditor',
      });

      await expect(
        service.setMaintenanceMode({ enabled: true }, 'auditor-1'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.executeEmergencyAction(
          { action: EmergencyAction.PAUSE_ALL_QUEUES, reason: 'x' },
          'auditor-1',
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(storedControl).toBeNull();
    });

    it('records every mutation in operational_control_events with before/after state', async () => {
      await service.setMaintenanceMode(
        { enabled: true, reason: 'audit me' },
        'admin-1',
      );

      const savedEvents = mockControlEventRepo.save.mock.calls.map((c) => c[0]);
      expect(savedEvents.length).toBeGreaterThan(0);
      const event = savedEvents[0];
      expect(event.operation).toBe('maintenance_enable');
      expect(event.actorId).toBe('admin-1');
      expect(event.auditReference).toMatch(/^oce-/);
      expect(event.controlVersion).toBe(storedControl.version);
      expect(event.beforeState).toBeDefined();
      expect(event.afterState).toBeDefined();
    });

    it('marks on-chain-required emergency actions as request-bound pending canonical work', async () => {
      const result = await service.executeEmergencyAction(
        {
          action: EmergencyAction.EMERGENCY_SHUTDOWN,
          reason: 'chain pause required',
        },
        'admin-1',
      );

      expect(result.canonicalStatus).toBe('pending');
      expect(result.canonicalRequestId).toBeDefined();
      const pending =
        storedControl.pendingCanonicalActions[result.canonicalRequestId!];
      expect(pending).toMatchObject({
        action: EmergencyAction.EMERGENCY_SHUTDOWN,
        status: 'pending',
        requestedBy: 'admin-1',
        canonicalEvidenceRequired: true,
      });
    });

    it('derives suppressed service state from persisted emergencies, not a local map', async () => {
      await service.executeEmergencyAction(
        {
          action: EmergencyAction.DISABLE_NOTIFICATIONS,
          reason: 'spam wave',
        },
        'admin-1',
      );

      let status = await service.getSystemStatus();
      expect(status.notificationsEnabled).toBe(false);

      await service.resolveEmergencyAction(
        EmergencyAction.DISABLE_NOTIFICATIONS,
        'admin-1',
      );

      status = await service.getSystemStatus();
      expect(status.notificationsEnabled).toBe(true);
      expect(storedControl.emergencies).toEqual({});
    });

    it('persists manual service suspension across reconcile', async () => {
      await service.controlService(
        {
          serviceType: ServiceType.NOTIFICATION,
          action: ServiceAction.SUSPEND,
          reason: 'provider outage',
        },
        'admin-1',
      );

      expect(storedControl.services.notifications).toBe(false);

      const status = await service.getSystemStatus();
      expect(status.notificationsEnabled).toBe(false);
    });

    it('resolves pending canonical actions only with finalized evidence bound to the request', async () => {
      const result = await service.executeEmergencyAction(
        {
          action: EmergencyAction.PAUSE_ALL_QUEUES,
          reason: 'chain pause',
        },
        'admin-1',
      );
      const requestId = result.canonicalRequestId!;

      await expect(
        service.resolveCanonicalAction(
          EmergencyAction.PAUSE_ALL_QUEUES,
          { requestId, transactionHash: 'abc123' },
          'admin-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(storedControl.pendingCanonicalActions[requestId].status).toBe(
        'pending',
      );

      mockIndexedEventRepo.find.mockResolvedValueOnce([
        {
          id: 'event-1',
          transactionHash: 'abc123',
          chainId: 42,
          logIndex: 0,
          blockNumber: '100',
          eventType: 'EmergencyPaused',
          isFinalized: true,
          eventData: { requestId },
          parsedData: { action: EmergencyAction.PAUSE_ALL_QUEUES, requestId },
        },
      ] as any);

      await service.resolveCanonicalAction(
        EmergencyAction.PAUSE_ALL_QUEUES,
        { requestId, transactionHash: 'abc123', ledger: 42 },
        'admin-1',
      );

      expect(storedControl.pendingCanonicalActions[requestId].status).toBe(
        'resolved',
      );

      // A second resolve must fail — the request is no longer pending.
      await expect(
        service.resolveCanonicalAction(
          EmergencyAction.PAUSE_ALL_QUEUES,
          { requestId, transactionHash: 'abc123' },
          'admin-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects finalized evidence whose action does not match the pending request', async () => {
      const result = await service.executeEmergencyAction(
        {
          action: EmergencyAction.EMERGENCY_SHUTDOWN,
          reason: 'chain halt',
        },
        'admin-1',
      );
      const requestId = result.canonicalRequestId!;

      mockIndexedEventRepo.find.mockResolvedValueOnce([
        {
          id: 'event-wrong-action',
          transactionHash: 'abc123',
          chainId: 42,
          logIndex: 0,
          blockNumber: '100',
          eventType: 'EmergencyPaused',
          isFinalized: true,
          eventData: { requestId },
          parsedData: {
            action: EmergencyAction.DISABLE_NOTIFICATIONS,
            requestId,
          },
        } as any,
      ]);

      await expect(
        service.resolveCanonicalAction(
          EmergencyAction.EMERGENCY_SHUTDOWN,
          { requestId, transactionHash: 'abc123', ledger: 42 },
          'admin-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(storedControl.pendingCanonicalActions[requestId].status).toBe(
        'pending',
      );
    });

    it('rejects schedule boundaries without an explicit UTC offset', async () => {
      await expect(
        service.scheduleMaintenance(
          {
            description: 'ambiguous boundary',
            startTime: '2027-01-10T10:00:00',
          },
          'admin-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechecks that the administrator is still active', async () => {
      mockAdminRepo.findOneBy.mockResolvedValue(null);

      await expect(
        service.setMaintenanceMode({ enabled: true }, 'admin-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(mockAdminRepo.findOneBy).toHaveBeenCalledWith({
        id: 'admin-1',
        isActive: true,
      });
      expect(storedControl).toBeNull();
    });

    it('serializes mutations through a pessimistic row lock', async () => {
      await service.setMaintenanceMode({ enabled: true }, 'admin-1');

      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockControlRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          lock: { mode: 'pessimistic_write' },
        }),
      );
    });
  });
});

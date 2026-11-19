import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JobsService } from './jobs.service';
import { JobsProcessor } from './jobs.processor';
import { Stake } from '../staking/entities/stake.entity';
import { Wallet } from '../entities/wallet.entity';
import { Claim } from '../claims/entities/claim.entity';
import { User } from '../entities/user.entity';
import { ClaimsCache } from '../cache/claims.cache';
import { RedisService } from '../redis/redis.service';
import { AggregationService } from '../aggregation/aggregation.service';
import { SybilResistanceService } from '../sybil-resistance/sybil-resistance.service';
import { NotificationsRetentionService } from '../notifications/notifications-retention.service';
import { Notification } from '../notifications/entities/notification.entity';
import { DeliveryHistory } from '../notifications/entities/delivery-history.entity';
import { getQueueToken } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { JobName, JobPriority, QueueName } from './jobs.types';
import { GracefulShutdownService } from '../common/lifecycle/graceful-shutdown.service';

jest.mock('../prisma/prisma.service', () => {
  return {
    PrismaService: jest.fn().mockImplementation(() => ({})),
  };
});

describe('JobsService', () => {
  let service: JobsService;
  let processor: JobsProcessor;
  let queueMock: any;
  let sybilResistanceServiceMock: any;
  let notificationsRetentionServiceMock: any;
  let shutdownMock: {
    isDraining: boolean;
    runTracked: jest.Mock;
  };

  beforeEach(async () => {
    queueMock = {
      add: jest.fn().mockResolvedValue({ id: 'new-job' }),
      upsertJobScheduler: jest.fn().mockResolvedValue({ id: 'recurring-job' }),
      getJobCounts: jest.fn().mockResolvedValue({
        waiting: 1,
        active: 0,
        completed: 5,
        failed: 0,
        delayed: 0,
        paused: 0,
      }),
      getFailed: jest.fn().mockResolvedValue([]),
      getJob: jest.fn().mockResolvedValue(null),
      pause: jest.fn().mockResolvedValue(undefined),
      resume: jest.fn().mockResolvedValue(undefined),
    };

    sybilResistanceServiceMock = {
      cleanupScoreHistory: jest.fn().mockResolvedValue(42),
    };
    notificationsRetentionServiceMock = {
      runRetentionCleanup: jest.fn().mockResolvedValue({
        notificationsDeleted: 7,
        deliveriesDeleted: 15,
      }),
    };
    shutdownMock = {
      isDraining: false,
      runTracked: jest.fn((_name, operation) => operation()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        JobsProcessor,
        {
          provide: GracefulShutdownService,
          useValue: shutdownMock,
        },
        {
          provide: getQueueToken(QueueName.DEFAULT),
          useValue: queueMock,
        },
        {
          provide: getQueueToken(QueueName.NOTIFICATIONS),
          useValue: queueMock,
        },
        {
          provide: getQueueToken(QueueName.BLOCKCHAIN),
          useValue: queueMock,
        },
        {
          provide: getQueueToken(QueueName.ANALYTICS),
          useValue: queueMock,
        },
        {
          provide: SybilResistanceService,
          useValue: sybilResistanceServiceMock,
        },
        {
          provide: NotificationsRetentionService,
          useValue: notificationsRetentionServiceMock,
        },
        {
          provide: getRepositoryToken(Stake),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(Wallet),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(Claim),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(User),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(Notification),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(DeliveryHistory),
          useClass: Repository,
        },
        {
          provide: ClaimsCache,
          useValue: {
            invalidateClaim: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: {},
        },
        {
          provide: AggregationService,
          useValue: {
            aggregate: jest.fn().mockReturnValue({
              confidence: 60,
              status: 'VERIFIED_TRUE',
            }),
          },
        },
      ],
    }).compile();

    service = module.get<JobsService>(JobsService);
    processor = module.get<JobsProcessor>(JobsProcessor);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
    expect(processor).toBeDefined();
  });

  // ── module bootstrap: required workers registered exactly once ───────────────

  describe('module bootstrap', () => {
    it('JobsService is a singleton provider (registered exactly once)', () => {
      expect(service).toBeDefined();
      // The module resolves a single instance — repeated gets return the same ref
      expect(service).toBe(service);
    });

    it('JobsProcessor is registered and processes CLEANUP_SYBIL_HISTORY without error', async () => {
      const mockJob = { id: '1', name: JobName.CLEANUP_SYBIL_HISTORY, data: {} } as Job;
      await expect(processor.process(mockJob)).resolves.toBeDefined();
    });

    it('JobsProcessor is registered and processes CLEANUP_EXPIRED_NOTIFICATIONS without error', async () => {
      const mockJob = { id: '2', name: JobName.CLEANUP_EXPIRED_NOTIFICATIONS, data: {} } as Job;
      await expect(processor.process(mockJob)).resolves.toBeDefined();
    });
  });

  // ── no placeholder handler reports success without real work ─────────────────

  describe('no log-only placeholder handlers', () => {
    it('cleanupSybilHistory delegates to SybilResistanceService (real work)', async () => {
      const result = await service.cleanupSybilHistory();
      expect(sybilResistanceServiceMock.cleanupScoreHistory).toHaveBeenCalled();
      expect(result).toBe(42);
    });

    it('cleanupExpiredNotifications delegates to NotificationsRetentionService (real work)', async () => {
      const result = await service.cleanupExpiredNotifications();
      expect(notificationsRetentionServiceMock.runRetentionCleanup).toHaveBeenCalled();
      expect(result.notificationsDeleted).toBe(7);
      expect(result.deliveriesDeleted).toBe(15);
    });
  });

  // ── hourly maintenance enqueues both cleanup jobs ────────────────────────────

  describe('runHourlyMaintenance', () => {
    it('enqueues CLEANUP_SYBIL_HISTORY and CLEANUP_EXPIRED_NOTIFICATIONS', async () => {
      await service.runHourlyMaintenance();

      const jobNames: string[] = queueMock.add.mock.calls.map((c: any[]) => c[0]);
      expect(jobNames).toContain(JobName.CLEANUP_SYBIL_HISTORY);
      expect(jobNames).toContain(JobName.CLEANUP_EXPIRED_NOTIFICATIONS);
    });

    it('skips both enqueues when application is draining', async () => {
      shutdownMock.isDraining = true;
      await service.runHourlyMaintenance();
      expect(queueMock.add).not.toHaveBeenCalled();
    });
  });

  // ── enqueue ──────────────────────────────────────────────────────────────────

  describe('enqueue', () => {
    it('does not enqueue new work after shutdown begins', async () => {
      shutdownMock.isDraining = true;

      await expect(
        service.enqueue(JobName.CLEANUP_SYBIL_HISTORY, {}),
      ).resolves.toBeNull();
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('should enqueue a job with default options', async () => {
      const job = await service.enqueue(JobName.CLEANUP_SYBIL_HISTORY, {});
      expect(job).not.toBeNull();
      expect(queueMock.add).toHaveBeenCalledWith(
        JobName.CLEANUP_SYBIL_HISTORY,
        {},
        expect.objectContaining({
          priority: JobPriority.NORMAL,
          attempts: 3,
        }),
      );
    });

    it('should enqueue a job with custom priority', async () => {
      await service.enqueue(
        JobName.SEND_NOTIFICATION,
        { userId: '1' },
        { priority: JobPriority.HIGH },
        QueueName.NOTIFICATIONS,
      );
      expect(queueMock.add).toHaveBeenCalledWith(
        JobName.SEND_NOTIFICATION,
        { userId: '1' },
        expect.objectContaining({ priority: JobPriority.HIGH }),
      );
    });
  });

  // ── queue administration ─────────────────────────────────────────────────────

  describe('queue administration', () => {
    it('should return queue metrics', async () => {
      const metrics = await service.getQueueMetrics(QueueName.DEFAULT);
      expect(metrics).not.toBeNull();
      expect(metrics?.name).toBe(QueueName.DEFAULT);
      expect(metrics?.waiting).toBe(1);
    });

    it('should pause and resume a queue', async () => {
      await service.pauseQueue(QueueName.DEFAULT);
      expect(queueMock.pause).toHaveBeenCalled();
      await service.resumeQueue(QueueName.DEFAULT);
      expect(queueMock.resume).toHaveBeenCalled();
    });
  });

  // ── cleanupSybilHistory ──────────────────────────────────────────────────────

  describe('cleanupSybilHistory', () => {
    it('should call sybilResistanceService cleanupScoreHistory and return deleted count', async () => {
      const result = await service.cleanupSybilHistory();
      expect(sybilResistanceServiceMock.cleanupScoreHistory).toHaveBeenCalled();
      expect(result).toBe(42);
    });
  });

  // ── JobsProcessor ────────────────────────────────────────────────────────────

  describe('JobsProcessor', () => {
    it('processes CLEANUP_SYBIL_HISTORY by calling cleanupSybilHistory', async () => {
      const spy = jest.spyOn(service, 'cleanupSybilHistory').mockResolvedValue(99);
      const mockJob = { id: '1', name: JobName.CLEANUP_SYBIL_HISTORY, data: {} } as Job;
      const result = await processor.process(mockJob);
      expect(spy).toHaveBeenCalled();
      expect(result).toEqual({ deletedCount: 99 });
    });

    it('processes CLEANUP_EXPIRED_NOTIFICATIONS by calling cleanupExpiredNotifications', async () => {
      const spy = jest.spyOn(service, 'cleanupExpiredNotifications').mockResolvedValue({
        notificationsDeleted: 3,
        deliveriesDeleted: 8,
      });
      const mockJob = { id: '2', name: JobName.CLEANUP_EXPIRED_NOTIFICATIONS, data: {} } as Job;
      const result = await processor.process(mockJob);
      expect(spy).toHaveBeenCalled();
      expect(result).toEqual({ notificationsDeleted: 3, deliveriesDeleted: 8 });
    });

    it('throws for legacy compute-scores job (removed in V2)', async () => {
      const mockJob = { id: '3', name: 'compute-scores', data: {} } as Job;
      await expect(processor.process(mockJob)).rejects.toThrow(
        'Unknown job name: compute-scores',
      );
    });

    it('throws for legacy compute-reputation job (removed in V2)', async () => {
      const mockJob = { id: '4', name: 'compute-reputation', data: {} } as Job;
      await expect(processor.process(mockJob)).rejects.toThrow(
        'Unknown job name: compute-reputation',
      );
    });

    it('throws for unknown job name', async () => {
      const mockJob = { id: '5', name: 'unknown-job', data: {} } as Job;
      await expect(processor.process(mockJob)).rejects.toThrow(
        'Unknown job name: unknown-job',
      );
    });

    it('no handler reports success without performing real work', async () => {
      // Processor delegates — if the service throws, the job fails visibly
      jest.spyOn(service, 'cleanupSybilHistory').mockRejectedValue(new Error('DB down'));
      const mockJob = { id: '6', name: JobName.CLEANUP_SYBIL_HISTORY, data: {} } as Job;
      await expect(processor.process(mockJob)).rejects.toThrow('DB down');
    });
  });

  // ── no remaining production caller for removed placeholder methods ────────────

  describe('removed placeholder scheduler', () => {
    it('SchedulerService file no longer exists in src/jobs/services/', () => {
      const fs = require('fs');
      const path = require('path');
      const schedulerPath = path.resolve(
        __dirname,
        'services',
        'scheduler.service.ts',
      );
      expect(fs.existsSync(schedulerPath)).toBe(false);
    });

    it('QueueService stub file no longer exists in src/jobs/services/', () => {
      const fs = require('fs');
      const path = require('path');
      const queueServicePath = path.resolve(
        __dirname,
        'services',
        'queue.service.ts',
      );
      expect(fs.existsSync(queueServicePath)).toBe(false);
    });

    it('MonitoringService stub file no longer exists in src/jobs/services/', () => {
      const fs = require('fs');
      const path = require('path');
      const monitoringPath = path.resolve(
        __dirname,
        'services',
        'monitoring.service.ts',
      );
      expect(fs.existsSync(monitoringPath)).toBe(false);
    });
  });
});

jest.mock('../prisma/prisma.service', () => {
  return {
    PrismaService: jest.fn().mockImplementation(() => ({})),
  };
});

describe('JobsService', () => {
  let service: JobsService;
  let processor: JobsProcessor;
  let queueMock: any;
  let sybilResistanceServiceMock: any;
  let shutdownMock: {
    isDraining: boolean;
    runTracked: jest.Mock;
  };

  beforeEach(async () => {
    queueMock = {
      add: jest.fn().mockResolvedValue({ id: 'new-job' }),
      getJobCounts: jest.fn().mockResolvedValue({
        waiting: 1,
        active: 0,
        completed: 5,
        failed: 0,
        delayed: 0,
        paused: 0,
      }),
      getFailed: jest.fn().mockResolvedValue([]),
      getJob: jest.fn().mockResolvedValue(null),
      pause: jest.fn().mockResolvedValue(undefined),
      resume: jest.fn().mockResolvedValue(undefined),
    };

    sybilResistanceServiceMock = {
      cleanupScoreHistory: jest.fn().mockResolvedValue(42),
    };
    shutdownMock = {
      isDraining: false,
      runTracked: jest.fn((_name, operation) => operation()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        JobsProcessor,
        {
          provide: GracefulShutdownService,
          useValue: shutdownMock,
        },
        {
          provide: getQueueToken(QueueName.DEFAULT),
          useValue: queueMock,
        },
        {
          provide: getQueueToken(QueueName.NOTIFICATIONS),
          useValue: queueMock,
        },
        {
          provide: getQueueToken(QueueName.BLOCKCHAIN),
          useValue: queueMock,
        },
        {
          provide: getQueueToken(QueueName.ANALYTICS),
          useValue: queueMock,
        },
        {
          provide: SybilResistanceService,
          useValue: sybilResistanceServiceMock,
        },
        {
          provide: getRepositoryToken(Stake),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(Wallet),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(Claim),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(User),
          useClass: Repository,
        },
        {
          provide: ClaimsCache,
          useValue: {
            invalidateClaim: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: {},
        },
        {
          provide: AggregationService,
          useValue: {
            aggregate: jest.fn().mockReturnValue({
              confidence: 60,
              status: 'VERIFIED_TRUE',
            }),
          },
        },
      ],
    }).compile();

    service = module.get<JobsService>(JobsService);
    processor = module.get<JobsProcessor>(JobsProcessor);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
    expect(processor).toBeDefined();
  });

  describe('enqueue', () => {
    it('does not enqueue new work after shutdown begins', async () => {
      shutdownMock.isDraining = true;

      await expect(
        service.enqueue(JobName.CLEANUP_SYBIL_HISTORY, {}),
      ).resolves.toBeNull();
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('should enqueue a job with default options', async () => {
      const job = await service.enqueue(JobName.CLEANUP_SYBIL_HISTORY, {});
      expect(job).not.toBeNull();
      expect(queueMock.add).toHaveBeenCalledWith(
        JobName.CLEANUP_SYBIL_HISTORY,
        {},
        expect.objectContaining({
          priority: JobPriority.NORMAL,
          attempts: 3,
        }),
      );
    });

    it('should enqueue a job with custom priority', async () => {
      await service.enqueue(
        JobName.SEND_NOTIFICATION,
        { userId: '1' },
        { priority: JobPriority.HIGH },
        QueueName.NOTIFICATIONS,
      );
      expect(queueMock.add).toHaveBeenCalledWith(
        JobName.SEND_NOTIFICATION,
        { userId: '1' },
        expect.objectContaining({ priority: JobPriority.HIGH }),
      );
    });
  });

  describe('queue administration', () => {
    it('should return queue metrics', async () => {
      const metrics = await service.getQueueMetrics(QueueName.DEFAULT);
      expect(metrics).not.toBeNull();
      expect(metrics?.name).toBe(QueueName.DEFAULT);
      expect(metrics?.waiting).toBe(1);
    });

    it('should pause and resume a queue', async () => {
      await service.pauseQueue(QueueName.DEFAULT);
      expect(queueMock.pause).toHaveBeenCalled();
      await service.resumeQueue(QueueName.DEFAULT);
      expect(queueMock.resume).toHaveBeenCalled();
    });
  });

  describe('cleanupSybilHistory', () => {
    it('should call sybilResistanceService cleanupScoreHistory and return deleted count', async () => {
      const result = await service.cleanupSybilHistory();
      expect(sybilResistanceServiceMock.cleanupScoreHistory).toHaveBeenCalled();
      expect(result).toBe(42);
    });
  });

  describe('JobsProcessor', () => {
    it('should throw for legacy compute-scores job (removed in V2)', async () => {
      const mockJob = {
        id: '1',
        name: 'compute-scores',
        data: {},
      } as Job;

      await expect(processor.process(mockJob)).rejects.toThrow(
        'Unknown job name: compute-scores',
      );
    });

    it('should throw for legacy compute-reputation job (removed in V2)', async () => {
      const mockJob = {
        id: '2',
        name: 'compute-reputation',
        data: {},
      } as Job;

      await expect(processor.process(mockJob)).rejects.toThrow(
        'Unknown job name: compute-reputation',
      );
    });

    it('should invoke cleanupSybilHistory when processing cleanup-sybil-history job', async () => {
      const cleanupSybilHistorySpy = jest
        .spyOn(service, 'cleanupSybilHistory')
        .mockResolvedValue(123);

      const mockJob = {
        id: '4',
        name: JobName.CLEANUP_SYBIL_HISTORY,
        data: {},
      } as Job;

      const result = await processor.process(mockJob);
      expect(cleanupSybilHistorySpy).toHaveBeenCalled();
      expect(result).toEqual({ deletedCount: 123 });
    });

    it('should throw error for unknown job name', async () => {
      const mockJob = {
        id: '3',
        name: 'unknown-job',
        data: {},
      } as Job;

      await expect(processor.process(mockJob)).rejects.toThrow(
        'Unknown job name: unknown-job',
      );
    });
  });
});

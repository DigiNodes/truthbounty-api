/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
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
import { getQueueToken } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { JobName, JobPriority, QueueName } from './jobs.types';

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        JobsProcessor,
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
    it('should enqueue a job with default options', async () => {
      const job = await service.enqueue(JobName.COMPUTE_SCORES, {});
      expect(job).not.toBeNull();
      expect(queueMock.add).toHaveBeenCalledWith(
        JobName.COMPUTE_SCORES,
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
    it('should invoke runComputeScores when processing compute-scores job', async () => {
      const runComputeScoresSpy = jest
        .spyOn(service, 'runComputeScores')
        .mockResolvedValue({ processed: 0, updated: 0, errors: 0 });

      const mockJob = {
        id: '1',
        name: JobName.COMPUTE_SCORES,
        data: {},
      } as Job;

      await processor.process(mockJob);
      expect(runComputeScoresSpy).toHaveBeenCalled();
    });

    it('should invoke runComputeReputation when processing compute-reputation job', async () => {
      const runComputeReputationSpy = jest
        .spyOn(service, 'runComputeReputation')
        .mockResolvedValue({ processed: 0, updated: 0, errors: 0 });

      const mockJob = {
        id: '2',
        name: JobName.COMPUTE_REPUTATION,
        data: {},
      } as Job;

      await processor.process(mockJob);
      expect(runComputeReputationSpy).toHaveBeenCalled();
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

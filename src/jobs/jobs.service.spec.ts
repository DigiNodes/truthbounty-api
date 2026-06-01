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

jest.mock('../prisma/prisma.service', () => {
  return {
    PrismaService: jest.fn().mockImplementation(() => ({})),
  };
});

import { SybilResistanceService } from '../sybil-resistance/sybil-resistance.service';
import { getQueueToken } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';

describe('Jobs (BullMQ & Scheduling)', () => {
  let service: JobsService;
  let processor: JobsProcessor;
  let queueMock: any;
  let sybilResistanceServiceMock: any;
  let stakeRepo: Repository<Stake>;
  let walletRepo: Repository<Wallet>;
  let claimRepo: Repository<Claim>;
  let userRepo: Repository<User>;

  beforeEach(async () => {
    queueMock = {
      getRepeatableJobs: jest.fn().mockResolvedValue([
        { key: 'old-scores-key' },
        { key: 'old-reputation-key' },
      ]),
      removeRepeatableByKey: jest.fn().mockResolvedValue(true),
      add: jest.fn().mockResolvedValue({ id: 'new-job' }),
    };

    sybilResistanceServiceMock = {
      cleanupScoreHistory: jest.fn().mockResolvedValue(42),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        JobsProcessor,
        {
          provide: getQueueToken('jobs-queue'),
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
    stakeRepo = module.get<Repository<Stake>>(getRepositoryToken(Stake));
    walletRepo = module.get<Repository<Wallet>>(getRepositoryToken(Wallet));
    claimRepo = module.get<Repository<Claim>>(getRepositoryToken(Claim));
    userRepo = module.get<Repository<User>>(getRepositoryToken(User));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
    expect(processor).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should clear old repeatable jobs and schedule new ones', async () => {
      await service.onModuleInit();

      expect(queueMock.getRepeatableJobs).toHaveBeenCalled();
      expect(queueMock.removeRepeatableByKey).toHaveBeenCalledTimes(2);
      expect(queueMock.removeRepeatableByKey).toHaveBeenNthCalledWith(1, 'old-scores-key');
      expect(queueMock.removeRepeatableByKey).toHaveBeenNthCalledWith(2, 'old-reputation-key');
      
      expect(queueMock.add).toHaveBeenCalledTimes(3);
      expect(queueMock.add).toHaveBeenNthCalledWith(1, 'compute-scores', {}, expect.any(Object));
      expect(queueMock.add).toHaveBeenNthCalledWith(2, 'compute-reputation', {}, expect.any(Object));
      expect(queueMock.add).toHaveBeenNthCalledWith(3, 'cleanup-sybil-history', {}, expect.any(Object));
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
    it('should invoke computeScores when processing compute-scores job', async () => {
      const computeScoresSpy = jest.spyOn(service, 'computeScores').mockResolvedValue(undefined);

      const mockJob = {
        id: '1',
        name: 'compute-scores',
        data: {},
      } as Job;

      const result = await processor.process(mockJob);

      expect(computeScoresSpy).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it('should invoke computeReputation when processing compute-reputation job', async () => {
      const computeReputationSpy = jest.spyOn(service, 'computeReputation').mockResolvedValue(undefined);

      const mockJob = {
        id: '2',
        name: 'compute-reputation',
        data: {},
      } as Job;

      const result = await processor.process(mockJob);

      expect(computeReputationSpy).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it('should invoke cleanupSybilHistory when processing cleanup-sybil-history job', async () => {
      const cleanupSybilHistorySpy = jest.spyOn(service, 'cleanupSybilHistory').mockResolvedValue(123);

      const mockJob = {
        id: '4',
        name: 'cleanup-sybil-history',
        data: {},
      } as Job;

      const result = await processor.process(mockJob);

      expect(cleanupSybilHistorySpy).toHaveBeenCalled();
      expect(result).toEqual({ success: true, deletedCount: 123 });
    });

    it('should throw error for unknown job name', async () => {
      const mockJob = {
        id: '3',
        name: 'unknown-job',
        data: {},
      } as Job;

      await expect(processor.process(mockJob)).rejects.toThrow('Unknown job name: unknown-job');
    });
  });
});

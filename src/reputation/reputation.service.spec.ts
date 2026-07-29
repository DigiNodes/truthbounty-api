import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ReputationService } from './reputation.service';
import { ReputationCache } from './reputation.cache';
import {
  ReputationRecord,
  ReputationEvent,
  ReputationEventType,
} from './entities/reputation.entity';

describe('ReputationService', () => {
  let service: ReputationService;
  let reputationRepo: jest.Mocked<Repository<ReputationRecord>>;
  let eventRepo: jest.Mocked<Repository<ReputationEvent>>;
  let cache: jest.Mocked<ReputationCache>;

  beforeEach(async () => {
    const mockReputationRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const mockEventRepo = {
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const mockCache = {
      getUserReputation: jest.fn().mockResolvedValue(null),
      setUserReputation: jest.fn(),
      getLeaderboard: jest.fn().mockResolvedValue(null),
      setLeaderboard: jest.fn(),
      getEvents: jest.fn().mockResolvedValue(null),
      setEvents: jest.fn(),
      getStats: jest.fn().mockResolvedValue(null),
      setStats: jest.fn(),
      invalidateUser: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReputationService,
        {
          provide: getRepositoryToken(ReputationRecord),
          useValue: mockReputationRepo,
        },
        {
          provide: getRepositoryToken(ReputationEvent),
          useValue: mockEventRepo,
        },
        { provide: ReputationCache, useValue: mockCache },
      ],
    }).compile();

    service = module.get<ReputationService>(ReputationService);
    reputationRepo = module.get(getRepositoryToken(ReputationRecord));
    eventRepo = module.get(getRepositoryToken(ReputationEvent));
    cache = module.get(ReputationCache);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findByWallet', () => {
    it('should return reputation for a wallet', async () => {
      const mockRecord = {
        id: '1',
        walletAddress: '0x123',
        score: 100,
      } as ReputationRecord;
      reputationRepo.findOne.mockResolvedValue(mockRecord);

      const result = await service.findByWallet('0x123');
      expect(result).toEqual(mockRecord);
      expect(cache.setUserReputation).toHaveBeenCalledWith('0x123', mockRecord);
    });

    it('should return null if not found', async () => {
      reputationRepo.findOne.mockResolvedValue(null);

      const result = await service.findByWallet('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('findByWalletOrThrow', () => {
    it('should throw if not found', async () => {
      reputationRepo.findOne.mockResolvedValue(null);

      await expect(
        service.findByWalletOrThrow('nonexistent'),
      ).rejects.toThrow('Reputation record not found');
    });
  });

  describe('getLeaderboard', () => {
    it('should return leaderboard entries', async () => {
      const mockQueryBuilder = {
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          { walletAddress: '0x1', score: 100, verificationCount: 10, governanceParticipation: 5, rewardTotal: 50 },
          { walletAddress: '0x2', score: 80, verificationCount: 8, governanceParticipation: 3, rewardTotal: 30 },
        ]),
      };
      reputationRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getLeaderboard('highest', 10);
      expect(result).toHaveLength(2);
      expect(result[0].rank).toBe(1);
      expect(result[0].walletAddress).toBe('0x1');
    });
  });
});

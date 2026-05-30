import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SybilResistanceService } from './sybil-resistance.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';

describe('SybilResistanceService', () => {
  let service: SybilResistanceService;
  let prisma: any;
  let configService: ConfigService;

  // Mock user data
  const mockUserId = 'test-user-id';
  const mockWallet = {
    id: 'wallet-1',
    address: '0x1234567890123456789012345678901234567890',
    chain: 'ethereum',
    linkedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000), // 100 days ago
  };

  const mockUser: any = {
    id: mockUserId,
    createdAt: new Date(),
    updatedAt: new Date(),
    reputation: 0,
    worldcoinVerified: false,
    wallets: [mockWallet],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SybilResistanceService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: jest.fn(),
              findMany: jest.fn(),
              update: jest.fn(),
            },
            sybilScore: {
              create: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              if (key === 'sybil.minClaimsForAccuracyScore') return defaultValue ?? 5;
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<SybilResistanceService>(SybilResistanceService);
    prisma = module.get<any>(PrismaService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('computeSybilScore', () => {
    it('should compute a Sybil score deterministically', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);

      const { score, details } = await service.computeSybilScore(mockUserId);

      expect(score).toBeDefined();
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
      expect(details).toBeDefined();
      expect(details.componentScores).toBeDefined();
    });

    it('should throw NotFoundException for non-existent user', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(null);

      await expect(service.computeSybilScore('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should award higher score to Worldcoin verified users', async () => {
      const unverifiedUser: any = { ...mockUser, worldcoinVerified: false };
      const verifiedUser: any = { ...mockUser, worldcoinVerified: true };

      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(unverifiedUser);
      const { score: unverifiedScore } = await service.computeSybilScore(mockUserId);

      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(verifiedUser);
      const { score: verifiedScore } = await service.computeSybilScore(mockUserId);

      expect(verifiedScore).toBeGreaterThanOrEqual(unverifiedScore);
    });

    it('should account for wallet age in score calculation', async () => {
      const newWalletUser = {
        ...mockUser,
        wallets: [
          {
            ...mockWallet,
            linkedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
          },
        ],
      };

      const oldWalletUser = {
        ...mockUser,
        wallets: [
          {
            ...mockWallet,
            linkedAt: new Date(Date.now() - 150 * 24 * 60 * 60 * 1000), // 150 days ago
          },
        ],
      };

      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(newWalletUser);
      const { score: newScore } = await service.computeSybilScore(mockUserId);

      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(oldWalletUser);
      const { score: oldScore } = await service.computeSybilScore(mockUserId);

      expect(oldScore).toBeGreaterThan(newScore);
    });

    it('should include calculation details for explainability', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);

      const { details } = await service.computeSybilScore(mockUserId);

      expect(details.worldcoinWeight).toBe(0.3);
      expect(details.walletAgeWeight).toBe(0.25);
      expect(details.stakingWeight).toBe(0.25);
      expect(details.accuracyWeight).toBe(0.2);
      expect(details.componentScores.worldcoin).toBeDefined();
      expect(details.componentScores.walletAge).toBeDefined();
      expect(details.componentScores.staking).toBeDefined();
      expect(details.componentScores.accuracy).toBeDefined();
      expect(details.explanation).toBeDefined();
      expect(details.explanation.length).toBeGreaterThan(0);
    });
  });

  describe('recordSybilScore', () => {
    it('should store a Sybil score snapshot', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      const mockScoreRecord = {
        id: 'score-1',
        userId: mockUserId,
        worldcoinScore: 0.0,
        walletAgeScore: 0.67,
        stakingScore: 0.0,
        accuracyScore: 0.0,
        compositeScore: 0.27,
        calculationDetails: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.sybilScore, 'create').mockResolvedValueOnce(mockScoreRecord);

      const result = await service.recordSybilScore(mockUserId);

      expect(prisma.sybilScore.create).toHaveBeenCalled();
      expect(result.userId).toBe(mockUserId);
      expect(result.compositeScore).toBeDefined();
    });

    it('should throw NotFoundException for non-existent user', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(null);

      await expect(service.recordSybilScore('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getLatestSybilScore', () => {
    it('should return the most recent score', async () => {
      const mockScore = {
        id: 'score-1',
        userId: mockUserId,
        compositeScore: 0.5,
        worldcoinScore: 0.0,
        walletAgeScore: 0.67,
        stakingScore: 0.0,
        accuracyScore: 0.0,
        calculationDetails: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.sybilScore, 'findFirst').mockResolvedValueOnce(mockScore);

      const result = await service.getLatestSybilScore(mockUserId);

      expect(result.compositeScore).toBe(0.5);
      expect(prisma.sybilScore.findFirst).toHaveBeenCalledWith({
        where: { userId: mockUserId },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should compute and store score if none exists', async () => {
      jest.spyOn(prisma.sybilScore, 'findFirst').mockResolvedValueOnce(null);
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);

      const mockNewScore = {
        id: 'score-2',
        userId: mockUserId,
        compositeScore: 0.27,
        worldcoinScore: 0.0,
        walletAgeScore: 0.67,
        stakingScore: 0.0,
        accuracyScore: 0.0,
        calculationDetails: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.sybilScore, 'create').mockResolvedValueOnce(mockNewScore);

      const result = await service.getLatestSybilScore(mockUserId);

      expect(prisma.sybilScore.create).toHaveBeenCalled();
      expect(result.userId).toBe(mockUserId);
    });
  });

  describe('getSybilScoreHistory', () => {
    it('should return score history for a user', async () => {
      const mockHistory = [
        {
          id: 'score-1',
          userId: mockUserId,
          compositeScore: 0.5,
          worldcoinScore: 0.0,
          walletAgeScore: 0.67,
          stakingScore: 0.0,
          accuracyScore: 0.0,
          calculationDetails: '{}',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'score-2',
          userId: mockUserId,
          compositeScore: 0.52,
          worldcoinScore: 0.0,
          walletAgeScore: 0.69,
          stakingScore: 0.0,
          accuracyScore: 0.0,
          calculationDetails: '{}',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      jest.spyOn(prisma.sybilScore, 'findMany').mockResolvedValueOnce(mockHistory);

      const result = await service.getSybilScoreHistory(mockUserId);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(prisma.sybilScore.findMany).toHaveBeenCalledWith({
        where: { userId: mockUserId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
    });

    it('should respect limit parameter', async () => {
      jest.spyOn(prisma.sybilScore, 'findMany').mockResolvedValueOnce([]);

      await service.getSybilScoreHistory(mockUserId, 5);

      expect(prisma.sybilScore.findMany).toHaveBeenCalledWith({
        where: { userId: mockUserId },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
    });
  });

  describe('setWorldcoinVerified', () => {
    it('should update Worldcoin verification status', async () => {
      const mockUser: any = {
        id: mockUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
        reputation: 0,
        worldcoinVerified: false,
        wallets: [mockWallet],
      };

      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest.spyOn(prisma.user, 'update').mockResolvedValueOnce({
        ...mockUser,
        worldcoinVerified: true,
      });

      // Need to mock findUnique again for the score computation
      const verifiedUser: any = {
        ...mockUser,
        worldcoinVerified: true,
      };
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(verifiedUser);

      const mockScore = {
        id: 'score-1',
        userId: mockUserId,
        compositeScore: 0.57,
        worldcoinScore: 1.0,
        walletAgeScore: 0.67,
        stakingScore: 0.0,
        accuracyScore: 0.0,
        calculationDetails: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.sybilScore, 'create').mockResolvedValueOnce(mockScore);

      const result = await service.setWorldcoinVerified(mockUserId, true);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: mockUserId },
        data: { worldcoinVerified: true },
      });
      expect(result.worldcoinScore).toBe(1.0);
    });

    it('should throw NotFoundException for non-existent user', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(null);

      await expect(service.setWorldcoinVerified('non-existent', true)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should recalculate score after verification change', async () => {
      const mockUserBefore: any = {
        id: mockUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
        reputation: 0,
        worldcoinVerified: false,
        wallets: [mockWallet],
      };

      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUserBefore);
      jest.spyOn(prisma.user, 'update').mockResolvedValueOnce({
        ...mockUserBefore,
        worldcoinVerified: true,
      });

      // Mock findUnique for score computation
      const mockUserAfter: any = {
        ...mockUserBefore,
        worldcoinVerified: true,
      };
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUserAfter);

      const mockScore = {
        id: 'score-1',
        userId: mockUserId,
        compositeScore: 0.57,
        worldcoinScore: 1.0,
        walletAgeScore: 0.67,
        stakingScore: 0.0,
        accuracyScore: 0.0,
        calculationDetails: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.sybilScore, 'create').mockResolvedValueOnce(mockScore);

      await service.setWorldcoinVerified(mockUserId, true);

      expect(prisma.sybilScore.create).toHaveBeenCalled();
    });
  });

  describe('getSybilScoreForVoting', () => {
    it('should return score formatted for voting engines', async () => {
      const mockScore = {
        id: 'score-1',
        userId: mockUserId,
        compositeScore: 0.57,
        worldcoinScore: 1.0,
        walletAgeScore: 0.67,
        stakingScore: 0.0,
        accuracyScore: 0.0,
        calculationDetails: JSON.stringify({
          componentScores: { worldcoin: 1.0, walletAge: 0.67, staking: 0.0, accuracy: 0.0 },
          explanation: 'Test explanation',
        }),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.sybilScore, 'findFirst').mockResolvedValueOnce(mockScore);

      const result = await service.getSybilScoreForVoting(mockUserId);

      expect(result.userId).toBe(mockUserId);
      expect(result.score).toBe(0.57);
      expect(result.isVerified).toBe(true);
      expect(result.details).toBeDefined();
    });

    it('should indicate unverified status correctly', async () => {
      const mockScore = {
        id: 'score-1',
        userId: mockUserId,
        compositeScore: 0.27,
        worldcoinScore: 0.0, // Not verified
        walletAgeScore: 0.67,
        stakingScore: 0.0,
        accuracyScore: 0.0,
        calculationDetails: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.sybilScore, 'findFirst').mockResolvedValueOnce(mockScore);

      const result = await service.getSybilScoreForVoting(mockUserId);

      expect(result.isVerified).toBe(false);
    });
  });

  describe('recalculateAllScores', () => {
    it('should recalculate scores for all users', async () => {
      const user1: any = { ...mockUser, id: 'user-1' };
      const users = [user1];

      jest.spyOn(prisma.user, 'findMany').mockResolvedValueOnce(users);
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(user1);

      jest.spyOn(prisma.sybilScore, 'create').mockResolvedValueOnce({
        id: 'score-1',
        userId: 'user-1',
        compositeScore: 0.27,
        worldcoinScore: 0.0,
        walletAgeScore: 0.67,
        stakingScore: 0.0,
        accuracyScore: 0.0,
        calculationDetails: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.recalculateAllScores();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);
      expect(result[0].success).toBe(true);
      expect(result[0].userId).toBe('user-1');
    });

    it('should handle errors gracefully', async () => {
      const users = [{ id: 'user-1', ...mockUser }];

      jest.spyOn(prisma.user, 'findMany').mockResolvedValueOnce(users);
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(users[0]);
      jest
        .spyOn(prisma.sybilScore, 'create')
        .mockRejectedValueOnce(new Error('Database error'));

      const result = await service.recalculateAllScores();

      expect(result[0].success).toBe(false);
      expect(result[0].error).toBe('Database error');
    });
  });

  describe('MIN_CLAIMS_FOR_ACCURACY_SCORE configurability', () => {
    async function buildServiceWithMinClaims(minClaims: number): Promise<SybilResistanceService> {
      const mod = await Test.createTestingModule({
        providers: [
          SybilResistanceService,
          {
            provide: PrismaService,
            useValue: {
              user: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
              sybilScore: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
            },
          },
          {
            provide: ConfigService,
            useValue: {
              get: (key: string, defaultValue?: any) =>
                key === 'sybil.minClaimsForAccuracyScore' ? minClaims : defaultValue,
            },
          },
        ],
      }).compile();
      return mod.get<SybilResistanceService>(SybilResistanceService);
    }

    it('should use the default threshold of 5 when env var is not overridden', () => {
      // ConfigService mock returns default (5) — accuracy score is 0 for < 5 claims
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValue({
        ...mockUser,
        worldcoinVerified: false,
        wallets: [],
      });
      // Access private field via any cast to verify initialization
      expect((service as any).MIN_CLAIMS_FOR_ACCURACY_SCORE).toBe(5);
    });

    it('should read MIN_CLAIMS_FOR_ACCURACY_SCORE from ConfigService on construction', async () => {
      const customService = await buildServiceWithMinClaims(10);
      expect((customService as any).MIN_CLAIMS_FOR_ACCURACY_SCORE).toBe(10);
    });

    it('should not award accuracy score when claims voted on is below configured threshold', async () => {
      const customService = await buildServiceWithMinClaims(10);
      const prismaInCustom = (customService as any).prisma;

      // Provide a user whose claimsVotedOn would be below threshold
      jest.spyOn(prismaInCustom.user, 'findUnique').mockResolvedValue({
        ...mockUser,
        wallets: [],
      });

      const { details } = await customService.computeSybilScore(mockUserId);
      expect(details.componentScores.accuracy).toBe(0);
    });

    it('should award accuracy score when claims voted on meets custom threshold', async () => {
      // Use threshold of 3 and manually inject enough claims via gatherSignals override
      const customService = await buildServiceWithMinClaims(3);
      const prismaInCustom = (customService as any).prisma;

      jest.spyOn(prismaInCustom.user, 'findUnique').mockResolvedValue({
        ...mockUser,
        wallets: [],
      });

      // Spy on private gatherSignals to inject 4 correct out of 4 votes (above threshold 3)
      jest.spyOn(customService as any, 'gatherSignals').mockResolvedValue({
        worldcoinVerified: false,
        oldestWalletAgeMs: 0,
        totalStakedAmount: BigInt(0),
        claimsVotedOn: 4,
        claimsCorrect: 4,
      });

      const { details } = await customService.computeSybilScore(mockUserId);
      expect(details.componentScores.accuracy).toBe(1);
    });

    it('should treat boundary value (exactly equal to threshold) as meeting the threshold', async () => {
      const customService = await buildServiceWithMinClaims(3);
      const prismaInCustom = (customService as any).prisma;

      jest.spyOn(prismaInCustom.user, 'findUnique').mockResolvedValue({
        ...mockUser,
        wallets: [],
      });

      jest.spyOn(customService as any, 'gatherSignals').mockResolvedValue({
        worldcoinVerified: false,
        oldestWalletAgeMs: 0,
        totalStakedAmount: BigInt(0),
        claimsVotedOn: 3, // exactly at threshold
        claimsCorrect: 3,
      });

      const { details } = await customService.computeSybilScore(mockUserId);
      expect(details.componentScores.accuracy).toBe(1);
    });
  });

  describe('Edge cases', () => {
    it('should handle users with no wallets', async () => {
      const userNoWallets = {
        ...mockUser,
        wallets: [],
      };

      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(userNoWallets);

      const { score, details } = await service.computeSybilScore(mockUserId);

      expect(score).toBeDefined();
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
      expect(details.componentScores.walletAge).toBe(0);
    });

    it('should normalize all component scores to 0-1 range', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);

      const { details } = await service.computeSybilScore(mockUserId);

      expect(details.componentScores.worldcoin).toBeGreaterThanOrEqual(0);
      expect(details.componentScores.worldcoin).toBeLessThanOrEqual(1);
      expect(details.componentScores.walletAge).toBeGreaterThanOrEqual(0);
      expect(details.componentScores.walletAge).toBeLessThanOrEqual(1);
      expect(details.componentScores.staking).toBeGreaterThanOrEqual(0);
      expect(details.componentScores.staking).toBeLessThanOrEqual(1);
      expect(details.componentScores.accuracy).toBeGreaterThanOrEqual(0);
      expect(details.componentScores.accuracy).toBeLessThanOrEqual(1);
    });

    it('should produce deterministic scores for same input', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);

      const { score: score1 } = await service.computeSybilScore(mockUserId);

      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);

      const { score: score2 } = await service.computeSybilScore(mockUserId);

      expect(score1).toBe(score2);
    });
  });
});

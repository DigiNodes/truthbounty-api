import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SybilResistanceService } from './sybil-resistance.service';
import { SybilStakingAuthorityService } from './sybil-staking-authority.service';
import { ApprovedStakingAuthority } from './sybil-resistance.types';
import { StakeEvent } from '../staking/entities/stake-event.entity';
import { StakingEventType } from '../staking/types/staking-event.type';

jest.mock('../prisma/prisma.service', () => {
  return {
    PrismaService: jest.fn().mockImplementation(() => ({
      user: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      sybilScore: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
      },
    })),
  };
});

import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';

/** Helper: builds a mock QueryBuilder that returns `result` from getRawOne */
function makeQb(result: { total: string | null } | null) {
  const qb: any = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(result),
  };
  return qb;
}

describe('SybilResistanceService', () => {
  let service: SybilResistanceService;
  let prisma: any;
  let stakeEventRepo: any;
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

  const approvedAuthority: ApprovedStakingAuthority = {
    chainId: 11155420,
    releaseId: 'rel-opsepolia-20261015-v2',
    artifactHash:
      'f183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22f',
    contractAddress: '0x0000000000000000000000000000000000001004',
    deploymentBlock: 1000,
    finalizedThroughBlock: 24850000,
    finalizedBlockHash:
      '0xaa183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22',
    source: 'approved_runtime_registry',
    checkpointKey: 'test-approved-checkpoint-key',
  };

  let authorityService: {
    resolve: jest.Mock<Promise<ApprovedStakingAuthority | null>, []>;
  };

  beforeEach(async () => {
    authorityService = {
      resolve: jest.fn().mockResolvedValue(approvedAuthority),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SybilResistanceService,
        {
          provide: SybilStakingAuthorityService,
          useValue: authorityService,
        },
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: jest.fn(),
              findMany: jest.fn(),
              update: jest.fn(),
            },
            worldIdVerification: {
              findFirst: jest.fn().mockResolvedValue(null),
            },
            sybilScore: {
              create: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
              deleteMany: jest.fn(),
            },
            sybilExplanation: {
              create: jest.fn(),
              findFirst: jest.fn(),
            },
          },
        },
        {
          provide: getRepositoryToken(StakeEvent),
          useValue: {
            createQueryBuilder: jest.fn(() => makeQb({ total: null })),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              if (key === 'sybil.minClaimsForAccuracyScore')
                return defaultValue ?? 5;
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<SybilResistanceService>(SybilResistanceService);
    prisma = module.get<any>(PrismaService);
    stakeEventRepo = module.get(getRepositoryToken(StakeEvent));
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('computeSybilScore', () => {
    it('should compute a Sybil score deterministically', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);

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

      jest
        .spyOn(prisma.user, 'findUnique')
        .mockResolvedValueOnce(unverifiedUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      const { score: unverifiedScore } =
        await service.computeSybilScore(mockUserId);

      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(verifiedUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce({ id: 'v1', verifiedAt: new Date() });
      const { score: verifiedScore } =
        await service.computeSybilScore(mockUserId);

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

      jest
        .spyOn(prisma.user, 'findUnique')
        .mockResolvedValueOnce(newWalletUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      const { score: newScore } = await service.computeSybilScore(mockUserId);

      jest
        .spyOn(prisma.user, 'findUnique')
        .mockResolvedValueOnce(oldWalletUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      const { score: oldScore } = await service.computeSybilScore(mockUserId);

      expect(oldScore).toBeGreaterThan(newScore);
    });

    it('should include calculation details for explainability', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);

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
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
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

      jest
        .spyOn(prisma.sybilScore, 'create')
        .mockResolvedValueOnce(mockScoreRecord);
      jest.spyOn(prisma.sybilExplanation, 'create').mockResolvedValueOnce({
        id: 'ex-1',
        sybilScoreId: 'score-1',
        explanation: 'exp',
      });

      const result = await service.recordSybilScore(mockUserId);

      expect(prisma.sybilScore.create).toHaveBeenCalled();
      expect(prisma.sybilExplanation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ sybilScoreId: 'score-1' }),
        }),
      );
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
    beforeEach(() => {
      authorityService.resolve.mockResolvedValue(null);
    });

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

      jest
        .spyOn(prisma.sybilScore, 'findFirst')
        .mockResolvedValueOnce(mockScore);

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
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);

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

      jest
        .spyOn(prisma.sybilScore, 'create')
        .mockResolvedValueOnce(mockNewScore);

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

      jest
        .spyOn(prisma.sybilScore, 'findMany')
        .mockResolvedValueOnce(mockHistory);

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
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce({ id: 'v1', verifiedAt: new Date() });

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

      await expect(
        service.setWorldcoinVerified('non-existent', true),
      ).rejects.toThrow(NotFoundException);
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

      jest
        .spyOn(prisma.user, 'findUnique')
        .mockResolvedValueOnce(mockUserBefore);
      jest.spyOn(prisma.user, 'update').mockResolvedValueOnce({
        ...mockUserBefore,
        worldcoinVerified: true,
      });

      // Mock findUnique for score computation
      const mockUserAfter: any = {
        ...mockUserBefore,
        worldcoinVerified: true,
      };
      jest
        .spyOn(prisma.user, 'findUnique')
        .mockResolvedValueOnce(mockUserAfter);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce({ id: 'v1', verifiedAt: new Date() });

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
    beforeEach(() => {
      authorityService.resolve.mockResolvedValue(null);
    });

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
          componentScores: {
            worldcoin: 1.0,
            walletAge: 0.67,
            staking: 0.0,
            accuracy: 0.0,
          },
          explanation: 'Test explanation',
        }),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest
        .spyOn(prisma.sybilScore, 'findFirst')
        .mockResolvedValueOnce(mockScore);

      const result = await service.getSybilScoreForVoting(mockUserId);

      expect(result.userId).toBe(mockUserId);
      expect(result.score).toBe(0.57);
      expect(result.isVerified).toBe(true);
      expect(result.details).toBeDefined();
    });

    it('should load explanation from SybilExplanation if not present in calculationDetails', async () => {
      const mockScore = {
        id: 'score-1',
        userId: mockUserId,
        compositeScore: 0.57,
        worldcoinScore: 1.0,
        walletAgeScore: 0.67,
        stakingScore: 0.0,
        accuracyScore: 0.0,
        calculationDetails: JSON.stringify({
          componentScores: { worldcoin: 1.0 },
        }),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest
        .spyOn(prisma.sybilScore, 'findFirst')
        .mockResolvedValueOnce(mockScore);
      jest.spyOn(prisma.sybilExplanation, 'findFirst').mockResolvedValueOnce({
        id: 'ex-1',
        sybilScoreId: 'score-1',
        explanation: 'Stored explanation',
      });

      const result = await service.getSybilScoreForVoting(mockUserId);

      expect(result.details).toBeDefined();
      expect(result.details.explanation).toBe('Stored explanation');
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

      jest
        .spyOn(prisma.sybilScore, 'findFirst')
        .mockResolvedValueOnce(mockScore);

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
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);

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
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      jest
        .spyOn(prisma.sybilScore, 'create')
        .mockRejectedValueOnce(new Error('Database error'));

      const result = await service.recalculateAllScores();

      expect(result[0].success).toBe(false);
      expect(result[0].error).toBe('Database error');
    });
  });

  describe('MIN_CLAIMS_FOR_ACCURACY_SCORE configurability', () => {
    async function buildServiceWithMinClaims(
      minClaims: number,
    ): Promise<SybilResistanceService> {
      const mod = await Test.createTestingModule({
        providers: [
          SybilResistanceService,
          {
            provide: SybilStakingAuthorityService,
            useValue: authorityService,
          },
          {
            provide: PrismaService,
            useValue: {
              user: {
                findUnique: jest.fn(),
                findMany: jest.fn(),
                update: jest.fn(),
              },
              worldIdVerification: {
                findFirst: jest.fn().mockResolvedValue(null),
              },
              sybilScore: {
                create: jest.fn(),
                findFirst: jest.fn(),
                findMany: jest.fn(),
              },
            },
          },
          {
            provide: getRepositoryToken(StakeEvent),
            useValue: {
              createQueryBuilder: jest.fn(() => makeQb({ total: null })),
            },
          },
          {
            provide: ConfigService,
            useValue: {
              get: (key: string, defaultValue?: any) =>
                key === 'sybil.minClaimsForAccuracyScore'
                  ? minClaims
                  : defaultValue,
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

      jest
        .spyOn(prisma.user, 'findUnique')
        .mockResolvedValueOnce(userNoWallets);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);

      const { score, details } = await service.computeSybilScore(mockUserId);

      expect(score).toBeDefined();
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
      expect(details.componentScores.walletAge).toBe(0);
    });

    it('should normalize all component scores to 0-1 range', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);

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

    it('should clamp the composite score to a maximum of 1.0 when normalized values overflow', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest.spyOn(service as any, 'normalizeSignals').mockReturnValue({
        worldcoin: 2.0,
        walletAge: 2.0,
        staking: 2.0,
        accuracy: 2.0,
      });

      const { score, details } = await service.computeSybilScore(mockUserId);

      expect(score).toBe(1.0);
      expect(details.explanation).toContain('Final score: 1.0000');
    });

    it('should produce deterministic scores for same input', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);

      const { score: score1 } = await service.computeSybilScore(mockUserId);

      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);

      const { score: score2 } = await service.computeSybilScore(mockUserId);

      expect(score1).toBe(score2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // stakingWeight — historical stake tests (issue #197)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('stakingWeight — historical stake integration (issue #197)', () => {
    const ONE_TOKEN = BigInt('1000000000000000000'); // 1e18

    /**
     * Configures the stakeEventRepo mock to return a given historical total.
     * Pass null to simulate no deposit history.
     */
    function mockHistoricalTotal(total: string | null) {
      stakeEventRepo.createQueryBuilder.mockReturnValue(
        makeQb(total ? { total } : { total: null }),
      );
    }

    it('stakingScore should be 0 when user has never staked (no deposit history)', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      mockHistoricalTotal(null);

      const { details } = await service.computeSybilScore(mockUserId);
      expect(details.componentScores.staking).toBe(0);
    });

    it('stakingScore should be > 0 when user has stake deposit history', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      // Deposit exactly MIN_STAKING_FOR_FULL_SCORE
      mockHistoricalTotal(ONE_TOKEN.toString());

      const { details } = await service.computeSybilScore(mockUserId);
      expect(details.componentScores.staking).toBeGreaterThan(0);
    });

    it('stakingScore should reach 1.0 at or above MIN_STAKING_FOR_FULL_SCORE', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      mockHistoricalTotal(ONE_TOKEN.toString());

      const { details } = await service.computeSybilScore(mockUserId);
      expect(details.componentScores.staking).toBe(1);
    });

    it('stakingScore should NOT decrease when a user withdraws their active stake', async () => {
      // First, compute score BEFORE withdrawal (1 token deposited)
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      mockHistoricalTotal(ONE_TOKEN.toString());

      const { details: beforeWithdrawal } =
        await service.computeSybilScore(mockUserId);

      // Now simulate withdrawal: active stake is 0 BUT historical deposits remain 1 token.
      // The fix means we still read from StakeEvent deposits, so the score should be the same.
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      // Historical total is unchanged (deposits don't decrease on withdrawal)
      mockHistoricalTotal(ONE_TOKEN.toString());

      const { details: afterWithdrawal } =
        await service.computeSybilScore(mockUserId);

      expect(afterWithdrawal.componentScores.staking).toBeGreaterThanOrEqual(
        beforeWithdrawal.componentScores.staking,
      );
    });

    it('stakingScore should reflect cumulative deposits across multiple stake events', async () => {
      // User staked 0.3 + 0.4 + 0.3 = 1.0 token total across 3 events
      const total = (
        BigInt('300000000000000000') +
        BigInt('400000000000000000') +
        BigInt('300000000000000000')
      ).toString();

      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      mockHistoricalTotal(total);

      const { details } = await service.computeSybilScore(mockUserId);
      expect(details.componentScores.staking).toBe(1);
    });

    it('stakingScore should be higher for users with more historical deposits (partial stake)', async () => {
      const smallDeposit = (ONE_TOKEN / BigInt(10)).toString(); // 0.1 token
      const largeDeposit = (ONE_TOKEN / BigInt(2)).toString(); // 0.5 token

      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      mockHistoricalTotal(smallDeposit);
      const { details: smallDetails } =
        await service.computeSybilScore(mockUserId);

      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      mockHistoricalTotal(largeDeposit);
      const { details: largeDetails } =
        await service.computeSybilScore(mockUserId);

      expect(largeDetails.componentScores.staking).toBeGreaterThan(
        smallDetails.componentScores.staking,
      );
    });

    it('stakingScore should be 0 for users with no wallets (no addresses to query)', async () => {
      const userNoWallets = { ...mockUser, wallets: [] };

      jest
        .spyOn(prisma.user, 'findUnique')
        .mockResolvedValueOnce(userNoWallets);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);

      const { details } = await service.computeSybilScore(mockUserId);

      // No wallets → no addresses to query → stakeEventRepo should NOT be called
      expect(stakeEventRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(details.componentScores.staking).toBe(0);
    });

    it('stakingScore should not exceed 1.0 even for very large historical deposits', async () => {
      // 100x the threshold
      const hugeDeposit = (ONE_TOKEN * BigInt(100)).toString();

      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      mockHistoricalTotal(hugeDeposit);

      const { details } = await service.computeSybilScore(mockUserId);
      expect(details.componentScores.staking).toBeLessThanOrEqual(1.0);
    });

    it('composite score should be higher for a user with stake history vs zero stake', async () => {
      // User with stake history
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      mockHistoricalTotal(ONE_TOKEN.toString());
      const { score: withStake } = await service.computeSybilScore(mockUserId);

      // Same user with no stake history
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      mockHistoricalTotal(null);
      const { score: withoutStake } =
        await service.computeSybilScore(mockUserId);

      expect(withStake).toBeGreaterThan(withoutStake);
    });

    it('should query StakeEvent with STAKE_DEPOSITED type filter (not WITHDRAWN or SLASHED)', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      mockHistoricalTotal('0');

      await service.computeSybilScore(mockUserId);

      const qb = stakeEventRepo.createQueryBuilder.mock.results[0].value;
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('type'),
        expect.objectContaining({ type: StakingEventType.STAKE_DEPOSITED }),
      );
    });

    it('should query using the wallet address of linked wallets', async () => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValueOnce(null);
      mockHistoricalTotal('0');

      await service.computeSybilScore(mockUserId);

      const qb = stakeEventRepo.createQueryBuilder.mock.results[0].value;
      expect(qb.where).toHaveBeenCalledWith(
        expect.stringContaining('walletAddress'),
        expect.objectContaining({ addresses: [mockWallet.address] }),
      );
    });
  });

  describe('cleanupScoreHistory', () => {
    it('should delete scores older than 1 year and return count', async () => {
      jest
        .spyOn(prisma.sybilScore, 'deleteMany')
        .mockResolvedValueOnce({ count: 99 });

      const result = await service.cleanupScoreHistory();

      expect(prisma.sybilScore.deleteMany).toHaveBeenCalledWith({
        where: {
          createdAt: {
            lt: expect.any(Date),
          },
        },
      });
      expect(result).toBe(99);
    });
  });

  describe('finalized chain authority for staking signals (issue #869)', () => {
    const ONE_TOKEN = BigInt('1000000000000000000');

    const mockHistoricalTotal = (total: string | null) => {
      stakeEventRepo.createQueryBuilder.mockReturnValue(
        makeQb(total ? { total } : { total: null }),
      );
    };

    const makeEvent = (overrides: Record<string, unknown> = {}) => ({
      walletAddress: mockWallet.address,
      type: StakingEventType.STAKE_DEPOSITED,
      chainId: approvedAuthority.chainId,
      contractAddress: approvedAuthority.contractAddress,
      blockNumber: approvedAuthority.finalizedThroughBlock,
      amount: ONE_TOKEN.toString(),
      ...overrides,
    });

    const condition = (sql: string, params: any) => {
      if (sql.includes('walletAddress'))
        return (event: any) => params.addresses.includes(event.walletAddress);
      if (sql.includes('se.type'))
        return (event: any) => event.type === params.type;
      if (sql.includes('se.chainId'))
        return (event: any) => event.chainId === params.chainId;
      if (sql.includes('contractAddress'))
        return (event: any) =>
          event.contractAddress?.toLowerCase() ===
          params.contractAddress.toLowerCase();
      if (sql.includes('deploymentBlock'))
        return (event: any) => event.blockNumber >= params.deploymentBlock;
      if (sql.includes('finalizedBlock'))
        return (event: any) => event.blockNumber <= params.finalizedBlock;
      return () => true;
    };

    const makeEventFilteringQb = (events: any[]) => {
      const filters: Array<(event: any) => boolean> = [];
      const qb: any = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn((sql: string, params: any) => {
          filters.push(condition(sql, params));
          return qb;
        }),
        andWhere: jest.fn((sql: string, params: any) => {
          filters.push(condition(sql, params));
          return qb;
        }),
        getRawOne: jest.fn().mockImplementation(async () => {
          const matched = events.filter((event) =>
            filters.every((filter) => filter(event)),
          );
          const total = matched.reduce(
            (sum, event) => sum + BigInt(event.amount),
            0n,
          );
          return { total: total.toString() };
        }),
      };
      return qb;
    };

    beforeEach(() => {
      jest.spyOn(prisma.user, 'findUnique').mockResolvedValue(mockUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValue(null);
    });

    it('marks staking missing and never queries StakeEvent when no approved authority is available', async () => {
      authorityService.resolve.mockRejectedValueOnce(
        new Error('registry_unavailable'),
      );
      mockHistoricalTotal(ONE_TOKEN.toString());

      const { details } = await service.computeSybilScore(mockUserId);

      expect(stakeEventRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(details.componentScores.staking).toBe(0);
      expect(details.missingFeatures).toContain('staking');
      expect(details.stakingCheckpoint).toBeUndefined();
      expect(
        details.featureProvenance.staking.details.authorityError,
      ).toBe('authority_unavailable');
    });

    it('does not accept caller-supplied chain metadata in place of the registry authority', async () => {
      mockHistoricalTotal(ONE_TOKEN.toString());

      const { details } = await service.computeSybilScore(mockUserId, {
        authority: {
          chainId: approvedAuthority.chainId,
          releaseId: approvedAuthority.releaseId,
          artifactHash: approvedAuthority.artifactHash,
          contractAddress: approvedAuthority.contractAddress,
          finalizedThroughBlock: approvedAuthority.finalizedThroughBlock + 1,
        },
      });

      expect(stakeEventRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(details.componentScores.staking).toBe(0);
      expect(details.missingFeatures).toContain('staking');
    });

    it('binds the production query to chain, deployment and finalized block', async () => {
      mockHistoricalTotal(ONE_TOKEN.toString());

      await service.computeSybilScore(mockUserId);

      const qb = stakeEventRepo.createQueryBuilder.mock.results[0].value;
      expect(qb.andWhere).toHaveBeenCalledWith(
        'se.chainId = :chainId',
        expect.objectContaining({ chainId: approvedAuthority.chainId }),
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        'LOWER(se.contractAddress) = :contractAddress',
        expect.objectContaining({
          contractAddress: approvedAuthority.contractAddress.toLowerCase(),
        }),
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        'se.blockNumber >= :deploymentBlock',
        expect.objectContaining({
          deploymentBlock: approvedAuthority.deploymentBlock,
        }),
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        'se.blockNumber <= :finalizedBlock',
        expect.objectContaining({
          finalizedBlock: approvedAuthority.finalizedThroughBlock,
        }),
      );
    });

    it('excludes stake events above the finalized block or from another chain/deployment', async () => {
      stakeEventRepo.createQueryBuilder.mockReturnValue(
        makeEventFilteringQb([
          makeEvent(),
          makeEvent({ blockNumber: approvedAuthority.finalizedThroughBlock + 1 }),
          makeEvent({ chainId: 10 }),
          makeEvent({ contractAddress: '0x0000000000000000000000000000000000009999' }),
          makeEvent({ blockNumber: approvedAuthority.deploymentBlock - 1 }),
        ]),
      );

      const { details } = await service.computeSybilScore(mockUserId);

      expect(details.componentScores.staking).toBe(1);
      expect(details.featureProvenance.staking.details.totalDepositedUnits).toBe(
        ONE_TOKEN.toString(),
      );
    });

    it('does not count a score from unfinalized or wrong-chain events only', async () => {
      stakeEventRepo.createQueryBuilder.mockReturnValue(
        makeEventFilteringQb([
          makeEvent({ blockNumber: approvedAuthority.finalizedThroughBlock + 1 }),
          makeEvent({ chainId: 10 }),
        ]),
      );

      const { details } = await service.computeSybilScore(mockUserId);

      expect(details.componentScores.staking).toBe(0);
      expect(details.missingFeatures).toContain('staking');
    });

    it('uses the same approved checkpoint on public and internal score paths', async () => {
      mockHistoricalTotal(ONE_TOKEN.toString());

      const internal = await service.computeSybilScore(mockUserId);
      const publicView = await service.getPublicSybilScore(mockUserId);

      expect(authorityService.resolve).toHaveBeenCalledTimes(2);
      expect(publicView.provenanceDigest).toBe(
        internal.details.provenanceDigest,
      );
      expect(internal.details.stakingCheckpoint?.checkpointKey).toBe(
        approvedAuthority.checkpointKey,
      );
      expect((publicView as any).stakingCheckpoint).toBeUndefined();
    });

    it('records the exact finalized checkpoint and source provenance', async () => {
      mockHistoricalTotal(ONE_TOKEN.toString());

      const { details } = await service.computeSybilScore(mockUserId);

      expect(details.stakingCheckpoint).toEqual({
        chainId: approvedAuthority.chainId,
        releaseId: approvedAuthority.releaseId,
        artifactHash: approvedAuthority.artifactHash.toLowerCase(),
        contractAddress: approvedAuthority.contractAddress.toLowerCase(),
        deploymentBlock: approvedAuthority.deploymentBlock,
        finalizedThroughBlock: approvedAuthority.finalizedThroughBlock,
        finalizedBlockHash: approvedAuthority.finalizedBlockHash.toLowerCase(),
        source: 'approved_runtime_registry',
        checkpointKey: approvedAuthority.checkpointKey,
      });
      expect(
        details.featureProvenance.staking.details.checkpoint,
      ).toEqual(details.stakingCheckpoint);
    });

    it('recomputes a stored score deterministically when the checkpoint regresses or reorgs', async () => {
      const storedScore = {
        id: 'old-score',
        userId: mockUserId,
        compositeScore: 0.4,
        calculationDetails: JSON.stringify({
          stakingCheckpoint: { checkpointKey: 'previous-checkpoint-key' },
        }),
      };
      jest
        .spyOn(prisma.sybilScore, 'findFirst')
        .mockResolvedValueOnce(storedScore);
      const recomputed = {
        ...storedScore,
        id: 'new-score',
        compositeScore: 0.5,
      };
      jest.spyOn(prisma.sybilScore, 'create').mockResolvedValueOnce(recomputed);

      const result = await service.getLatestSybilScore(mockUserId);

      expect(authorityService.resolve).toHaveBeenCalled();
      expect(prisma.sybilScore.create).toHaveBeenCalled();
      expect(result.id).toBe('new-score');
    });

    it('keeps a stored score when its checkpoint still matches the registry', async () => {
      const storedScore = {
        id: 'current-score',
        userId: mockUserId,
        compositeScore: 0.5,
        calculationDetails: JSON.stringify({
          stakingCheckpoint: {
            checkpointKey: approvedAuthority.checkpointKey,
          },
        }),
      };
      jest
        .spyOn(prisma.sybilScore, 'findFirst')
        .mockResolvedValueOnce(storedScore);

      const result = await service.getLatestSybilScore(mockUserId);

      expect(prisma.sybilScore.create).not.toHaveBeenCalled();
      expect(result.id).toBe('current-score');
    });
  });
});

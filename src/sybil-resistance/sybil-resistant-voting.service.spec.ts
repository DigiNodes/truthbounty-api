import { Test, TestingModule } from '@nestjs/testing';
import { SybilResistantVotingService } from './sybil-resistant-voting.service';
import { SybilResistanceService } from './sybil-resistance.service';

describe('SybilResistantVotingService', () => {
  let votingService: SybilResistantVotingService;
  let sybilService: SybilResistanceService;

  const mockUser1 = 'user-1';
  const mockUser2 = 'user-2';
  const mockUser3 = 'user-3';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SybilResistantVotingService,
        {
          provide: SybilResistanceService,
          useValue: {
            getLatestSybilScore: jest.fn(),
          },
        },
      ],
    }).compile();

    votingService = module.get<SybilResistantVotingService>(
      SybilResistantVotingService,
    );
    sybilService = module.get<SybilResistanceService>(SybilResistanceService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('calculateSybilWeightedVote', () => {
    it('should apply multiplier based on Sybil score', async () => {
      const mockScore = {
        id: 'score-1',
        userId: mockUser1,
        compositeScore: 0.8,
        worldcoinScore: 1.0,
        walletAgeScore: 0.8,
        stakingScore: 0.6,
        accuracyScore: 0.8,
        calculationDetails: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(sybilService, 'getLatestSybilScore').mockResolvedValueOnce(mockScore);

      const result = await votingService.calculateSybilWeightedVote(mockUser1, 100);

      // Multiplier = 0.5 + (0.5 * 0.8) = 0.9
      expect(result.multiplier).toBe(0.9);
      expect(result.finalWeight).toBe(90);
      expect(result.sybilScore).toBe(0.8);
    });

    it('should reduce weight for low Sybil scores', async () => {
      const mockScore = {
        id: 'score-1',
        userId: mockUser1,
        compositeScore: 0.0,
        worldcoinScore: 0.0,
        walletAgeScore: 0.0,
        stakingScore: 0.0,
        accuracyScore: 0.0,
        calculationDetails: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(sybilService, 'getLatestSybilScore').mockResolvedValueOnce(mockScore);

      const result = await votingService.calculateSybilWeightedVote(mockUser1, 100);

      // Multiplier = 0.5 + (0.5 * 0.0) = 0.5
      expect(result.multiplier).toBe(0.5);
      expect(result.finalWeight).toBe(50);
    });

    it('should provide full weight for verified users', async () => {
      const mockScore = {
        id: 'score-1',
        userId: mockUser1,
        compositeScore: 1.0,
        worldcoinScore: 1.0,
        walletAgeScore: 1.0,
        stakingScore: 1.0,
        accuracyScore: 1.0,
        calculationDetails: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(sybilService, 'getLatestSybilScore').mockResolvedValueOnce(mockScore);

      const result = await votingService.calculateSybilWeightedVote(mockUser1, 100);

      // Multiplier = 0.5 + (0.5 * 1.0) = 1.0
      expect(result.multiplier).toBe(1.0);
      expect(result.finalWeight).toBe(100);
    });
  });

  describe('calculateSybilWeightedVotes', () => {
    it('should calculate weights for multiple votes', async () => {
      const mockScores = [
        {
          compositeScore: 0.8,
          worldcoinScore: 1.0,
          walletAgeScore: 0.8,
          stakingScore: 0.6,
          accuracyScore: 0.8,
        },
        {
          compositeScore: 0.5,
          worldcoinScore: 0.0,
          walletAgeScore: 0.67,
          stakingScore: 0.0,
          accuracyScore: 0.0,
        },
        {
          compositeScore: 1.0,
          worldcoinScore: 1.0,
          walletAgeScore: 1.0,
          stakingScore: 1.0,
          accuracyScore: 1.0,
        },
      ];

      jest
        .spyOn(sybilService, 'getLatestSybilScore')
        .mockResolvedValueOnce(mockScores[0] as any)
        .mockResolvedValueOnce(mockScores[1] as any)
        .mockResolvedValueOnce(mockScores[2] as any);

      const votes = [
        { userId: mockUser1, baseWeight: 100 },
        { userId: mockUser2, baseWeight: 100 },
        { userId: mockUser3, baseWeight: 100 },
      ];

      const results = await votingService.calculateSybilWeightedVotes(votes);

      expect(results).toHaveLength(3);
      expect(results[0].finalWeight).toBe(90); // 0.9 multiplier
      expect(results[1].finalWeight).toBe(75); // 0.75 multiplier
      expect(results[2].finalWeight).toBe(100); // 1.0 multiplier
    });
  });

  describe('getVotingImpactAnalysis', () => {
    it('should show weight reduction impact', async () => {
      const mockScores = [
        {
          compositeScore: 0.8,
          worldcoinScore: 1.0,
          walletAgeScore: 0.8,
          stakingScore: 0.6,
          accuracyScore: 0.8,
        },
        {
          compositeScore: 0.0,
          worldcoinScore: 0.0,
          walletAgeScore: 0.0,
          stakingScore: 0.0,
          accuracyScore: 0.0,
        },
      ];

      jest
        .spyOn(sybilService, 'getLatestSybilScore')
        .mockResolvedValueOnce(mockScores[0] as any)
        .mockResolvedValueOnce(mockScores[1] as any);

      const votes = [
        { userId: mockUser1, verdict: 'TRUE', baseWeight: 100 },
        { userId: mockUser2, verdict: 'FALSE', baseWeight: 100 },
      ];

      const result = await votingService.getVotingImpactAnalysis(votes);

      expect(result.originalTotalWeight).toBe(200);
      expect(result.sybilAdjustedTotalWeight).toBe(140); // 90 + 50
      expect(result.weightReduction).toBe(60);
      expect(result.percentageChange).toBe('30.00%');
    });
  });

  describe('meetsMinimumSybilScore', () => {
    it('should approve users meeting minimum score', async () => {
      const mockScore = {
        id: 'score-1',
        userId: mockUser1,
        compositeScore: 0.5,
        worldcoinScore: 0.0,
        walletAgeScore: 0.67,
        stakingScore: 0.0,
        accuracyScore: 0.0,
        calculationDetails: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(sybilService, 'getLatestSybilScore').mockResolvedValueOnce(mockScore);

      const result = await votingService.meetsMinimumSybilScore(mockUser1, 0.3);

      expect(result.eligible).toBe(true);
      expect(result.currentScore).toBe(0.5);
    });

    it('should reject users below minimum score', async () => {
      const mockScore = {
        id: 'score-1',
        userId: mockUser1,
        compositeScore: 0.1,
        worldcoinScore: 0.0,
        walletAgeScore: 0.13,
        stakingScore: 0.0,
        accuracyScore: 0.0,
        calculationDetails: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(sybilService, 'getLatestSybilScore').mockResolvedValueOnce(mockScore);

      const result = await votingService.meetsMinimumSybilScore(mockUser1, 0.5);

      expect(result.eligible).toBe(false);
    });
  });

  describe('getParticipationEligibility', () => {
    it('should report eligibility statistics', async () => {
      const mockScores = [
        {
          id: 'score-1',
          compositeScore: 0.7,
          worldcoinScore: 1.0,
          walletAgeScore: 0.7,
          stakingScore: 0.4,
          accuracyScore: 0.6,
        },
        {
          id: 'score-2',
          compositeScore: 0.3,
          worldcoinScore: 0.0,
          walletAgeScore: 0.4,
          stakingScore: 0.0,
          accuracyScore: 0.0,
        },
        {
          id: 'score-3',
          compositeScore: 0.9,
          worldcoinScore: 1.0,
          walletAgeScore: 0.9,
          stakingScore: 0.8,
          accuracyScore: 0.9,
        },
      ];

      jest
        .spyOn(sybilService, 'getLatestSybilScore')
        .mockResolvedValueOnce(mockScores[0] as any)
        .mockResolvedValueOnce(mockScores[1] as any)
        .mockResolvedValueOnce(mockScores[2] as any);

      const result = await votingService.getParticipationEligibility(
        [mockUser1, mockUser2, mockUser3],
        0.5,
      );

      expect(result.totalUsers).toBe(3);
      expect(result.eligibleUsers).toBe(2); // Users 1 and 3
      expect(result.ineligibleUsers).toBe(1); // User 2
      expect(result.eligibilityRate).toBe('66.67%');
    });

    it('should handle empty user list', async () => {
      const result = await votingService.getParticipationEligibility([], 0.5);

      expect(result.totalUsers).toBe(0);
      expect(result.eligibleUsers).toBe(0);
      expect(result.ineligibleUsers).toBe(0);
      expect(result.eligibilityRate).toBe('0%');
    });
  });

  describe('Edge cases', () => {
    it('should handle zero base weight', async () => {
      const mockScore = {
        id: 'score-1',
        userId: mockUser1,
        compositeScore: 0.5,
        worldcoinScore: 0.0,
        walletAgeScore: 0.67,
        stakingScore: 0.0,
        accuracyScore: 0.0,
        calculationDetails: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(sybilService, 'getLatestSybilScore').mockResolvedValueOnce(mockScore);

      const result = await votingService.calculateSybilWeightedVote(mockUser1, 0);

      expect(result.finalWeight).toBe(0);
    });

    it('should produce consistent weights across calls', async () => {
      const mockScore = {
        id: 'score-1',
        userId: mockUser1,
        compositeScore: 0.6,
        worldcoinScore: 0.0,
        walletAgeScore: 0.8,
        stakingScore: 0.0,
        accuracyScore: 0.0,
        calculationDetails: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest
        .spyOn(sybilService, 'getLatestSybilScore')
        .mockResolvedValueOnce(mockScore)
        .mockResolvedValueOnce(mockScore);

      const result1 = await votingService.calculateSybilWeightedVote(mockUser1, 100);
      const result2 = await votingService.calculateSybilWeightedVote(mockUser1, 100);

      expect(result1.finalWeight).toBe(result2.finalWeight);
      expect(result1.multiplier).toBe(result2.multiplier);
    });
  });
});

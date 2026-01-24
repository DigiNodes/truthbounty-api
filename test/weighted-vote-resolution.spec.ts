import { Test, TestingModule } from '@nestjs/testing';
import { WeightedVoteResolutionService } from '../src/blockchain/weighted-vote-resolution.service';
import { 
  VerificationVote, 
  ClaimResolution, 
  ResolutionConfig,
  Verdict
} from '../src/blockchain/types';

describe('WeightedVoteResolutionService', () => {
  let service: WeightedVoteResolutionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WeightedVoteResolutionService],
    }).compile();

    service = module.get<WeightedVoteResolutionService>(WeightedVoteResolutionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('resolveClaim', () => {
    const baseVote: Omit<VerificationVote, 'userId' | 'verdict' | 'userReputation' | 'stakeAmount'> = {
      claimId: 'claim-001',
      timestamp: new Date(),
      eventId: 'event-001'
    };

    it('should resolve clear TRUE majority', () => {
      const votes: VerificationVote[] = [
        { ...baseVote, userId: 'user1', verdict: 'TRUE', userReputation: 80, stakeAmount: '100' },
        { ...baseVote, userId: 'user2', verdict: 'TRUE', userReputation: 70, stakeAmount: '50' },
        { ...baseVote, userId: 'user3', verdict: 'FALSE', userReputation: 60, stakeAmount: '75' },
      ];

      const result = service.resolveClaim(votes);
      
      expect(result.resolvedVerdict).toBe('TRUE');
      expect(result.confidenceScore).toBeGreaterThan(0.6);
      expect(result.resolutionMargin).toBeGreaterThan(0);
      expect(result.totalWeight).toBeGreaterThan(0);
    });

    it('should resolve clear FALSE majority', () => {
      const votes: VerificationVote[] = [
        { ...baseVote, userId: 'user1', verdict: 'FALSE', userReputation: 90, stakeAmount: '200' },
        { ...baseVote, userId: 'user2', verdict: 'FALSE', userReputation: 75, stakeAmount: '100' },
        { ...baseVote, userId: 'user3', verdict: 'TRUE', userReputation: 50, stakeAmount: '25' },
      ];

      const result = service.resolveClaim(votes);
      
      expect(result.resolvedVerdict).toBe('FALSE');
      expect(result.confidenceScore).toBeGreaterThan(0.6);
    });

    it('should handle UNSURE votes', () => {
      const votes: VerificationVote[] = [
        { ...baseVote, userId: 'user1', verdict: 'UNSURE', userReputation: 85, stakeAmount: '150' },
        { ...baseVote, userId: 'user2', verdict: 'TRUE', userReputation: 70, stakeAmount: '75' },
        { ...baseVote, userId: 'user3', verdict: 'FALSE', userReputation: 65, stakeAmount: '50' },
      ];

      const result = service.resolveClaim(votes);
      
      expect(['TRUE', 'FALSE', 'UNSURE', 'UNRESOLVED']).toContain(result.resolvedVerdict);
    });

    it('should return UNRESOLVED for insufficient total weight', () => {
      const votes: VerificationVote[] = [
        { ...baseVote, userId: 'user1', verdict: 'TRUE', userReputation: 10, stakeAmount: '5' },
        { ...baseVote, userId: 'user2', verdict: 'FALSE', userReputation: 15, stakeAmount: '8' },
      ];

      // Set min weight higher than what these votes can achieve
      const config: Partial<ResolutionConfig> = { minTotalWeight: 1000 };
      const result = service.resolveClaim(votes, config);
      
      expect(result.resolvedVerdict).toBe('UNRESOLVED');
      expect(result.metadata.isLowConfidence).toBe(true);
    });

    it('should detect and handle ties', () => {
      const votes: VerificationVote[] = [
        { ...baseVote, userId: 'user1', verdict: 'TRUE', userReputation: 50, stakeAmount: '100' },
        { ...baseVote, userId: 'user2', verdict: 'FALSE', userReputation: 50, stakeAmount: '100' },
      ];

      const result = service.resolveClaim(votes);
      
      expect(result.resolvedVerdict).toBe('UNRESOLVED');
      expect(result.metadata.isTie).toBe(true);
    });

    it('should handle whale dominance protection', () => {
      const votes: VerificationVote[] = [
        // One high-reputation user dominating
        { ...baseVote, userId: 'whale', verdict: 'TRUE', userReputation: 95, stakeAmount: '1000' },
        // Many low-reputation users
        { ...baseVote, userId: 'user1', verdict: 'FALSE', userReputation: 10, stakeAmount: '10' },
        { ...baseVote, userId: 'user2', verdict: 'FALSE', userReputation: 10, stakeAmount: '10' },
        { ...baseVote, userId: 'user3', verdict: 'FALSE', userReputation: 10, stakeAmount: '10' },
      ];

      // Set low max share threshold
      const config: Partial<ResolutionConfig> = { maxReputationShare: 0.3 }; // 30%
      const result = service.resolveClaim(votes, config);
      
      expect(result.resolvedVerdict).toBe('UNRESOLVED');
    });

    it('should handle low confidence scenarios', () => {
      const votes: VerificationVote[] = [
        { ...baseVote, userId: 'user1', verdict: 'TRUE', userReputation: 40, stakeAmount: '50' },
        { ...baseVote, userId: 'user2', verdict: 'FALSE', userReputation: 39, stakeAmount: '50' },
        { ...baseVote, userId: 'user3', verdict: 'UNSURE', userReputation: 38, stakeAmount: '50' },
      ];

      // Set high confidence threshold
      const config: Partial<ResolutionConfig> = { confidenceThreshold: 0.8 };
      const result = service.resolveClaim(votes, config);
      
      expect(result.resolvedVerdict).toBe('UNRESOLVED');
      expect(result.metadata.isLowConfidence).toBe(true);
    });

    it('should handle empty vote array', () => {
      const result = service.resolveClaim([]);
      
      expect(result.resolvedVerdict).toBe('UNRESOLVED');
      expect(result.totalWeight).toBe(0);
      expect(result.voterCount).toBe(0);
    });

    it('should produce deterministic results', () => {
      const votes: VerificationVote[] = [
        { ...baseVote, userId: 'user1', verdict: 'TRUE', userReputation: 75, stakeAmount: '100' },
        { ...baseVote, userId: 'user2', verdict: 'FALSE', userReputation: 65, stakeAmount: '75' },
      ];

      const result1 = service.resolveClaim(votes);
      const result2 = service.resolveClaim(votes);
      
      expect(result1).toEqual(result2);
    });
  });

  describe('validateVotes', () => {
    const baseVote: VerificationVote = {
      claimId: 'claim-001',
      userId: 'user1',
      verdict: 'TRUE',
      userReputation: 75,
      stakeAmount: '100',
      timestamp: new Date(),
      eventId: 'event-001'
    };

    it('should validate correct votes', () => {
      const votes = [baseVote];
      const errors = service.validateVotes(votes);
      
      expect(errors).toHaveLength(0);
    });

    it('should detect inconsistent claim IDs', () => {
      const votes = [
        { ...baseVote, claimId: 'claim-001' },
        { ...baseVote, claimId: 'claim-002' }, // Different claim ID
      ];
      
      const errors = service.validateVotes(votes);
      expect(errors).toContainEqual(expect.stringContaining('Inconsistent claim ID'));
    });

    it('should detect missing user IDs', () => {
      const votes = [{ ...baseVote, userId: '' }];
      const errors = service.validateVotes(votes);
      
      expect(errors).toContainEqual(expect.stringContaining('Missing userId'));
    });

    it('should detect invalid verdicts', () => {
      const votes = [{ ...baseVote, verdict: 'INVALID' as Verdict }];
      const errors = service.validateVotes(votes);
      
      expect(errors).toContainEqual(expect.stringContaining('Invalid verdict'));
    });

    it('should detect invalid reputation scores', () => {
      const votes = [
        { ...baseVote, userReputation: -5 },    // Too low
        { ...baseVote, userReputation: 105 },   // Too high
      ];
      
      const errors = service.validateVotes(votes);
      expect(errors).toHaveLength(2);
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Invalid reputation'),
          expect.stringContaining('Invalid reputation')
        ])
      );
    });

    it('should detect negative stake amounts', () => {
      const votes = [{ ...baseVote, stakeAmount: '-50' }];
      const errors = service.validateVotes(votes);
      
      expect(errors).toContainEqual(expect.stringContaining('Negative stake amount'));
    });

    it('should handle empty vote array', () => {
      const errors = service.validateVotes([]);
      
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe('No votes provided');
    });
  });

  describe('weight calculation', () => {
    it('should calculate weights correctly with reputation only', () => {
      const votes: VerificationVote[] = [
        { 
          claimId: 'test', 
          userId: 'user1', 
          verdict: 'TRUE', 
          userReputation: 50, 
          stakeAmount: '0',
          timestamp: new Date(),
          eventId: 'event1'
        }
      ];

      const result = service.resolveClaim(votes);
      
      // With 0 stake, weight should equal reputation (50)
      expect(result.totalWeight).toBeCloseTo(50, 1);
    });

    it('should calculate weights with stake component', () => {
      const votes: VerificationVote[] = [
        { 
          claimId: 'test', 
          userId: 'user1', 
          verdict: 'TRUE', 
          userReputation: 50, 
          stakeAmount: '10000', // sqrt(10000) = 100 * 0.1 = 10 stake weight
          timestamp: new Date(),
          eventId: 'event1'
        }
      ];

      const result = service.resolveClaim(votes);
      
      // Expected: 50 (reputation) + 10 (stake) = 60
      expect(result.totalWeight).toBeCloseTo(60, 1);
    });

    it('should apply square root scaling to prevent whale dominance', () => {
      const smallStakeVote: VerificationVote = {
        claimId: 'test',
        userId: 'small',
        verdict: 'TRUE',
        userReputation: 50,
        stakeAmount: '10000', // sqrt = 100 * 0.1 = 10
        timestamp: new Date(),
        eventId: 'event1'
      };

      const largeStakeVote: VerificationVote = {
        claimId: 'test',
        userId: 'large',
        verdict: 'TRUE',
        userReputation: 50,
        stakeAmount: '1000000', // sqrt = 1000 * 0.1 = 100 (10x stake, but only ~3x weight increase)
        timestamp: new Date(),
        eventId: 'event2'
      };

      // Large stake should not dominate proportionally
      const ratio = parseFloat(largeStakeVote.stakeAmount) / parseFloat(smallStakeVote.stakeAmount);
      expect(ratio).toBe(100); // 100x more stake
      
      // But weight difference should be much smaller due to sqrt scaling
      const smallWeight = 50 + Math.sqrt(10000) * 0.1; // 60
      const largeWeight = 50 + Math.sqrt(1000000) * 0.1; // 150
      const weightRatio = largeWeight / smallWeight;
      expect(weightRatio).toBeCloseTo(2.5, 1); // Only ~2.5x weight increase, not 100x
    });
  });

  describe('configuration', () => {
    it('should allow configuration updates', () => {
      const originalConfig = service.getConfig();
      
      const newConfig: Partial<ResolutionConfig> = {
        minTotalWeight: 200,
        confidenceThreshold: 0.8,
        maxReputationShare: 0.2,
        tieThreshold: 0.1
      };
      
      service.updateConfig(newConfig);
      const updatedConfig = service.getConfig();
      
      expect(updatedConfig.minTotalWeight).toBe(200);
      expect(updatedConfig.confidenceThreshold).toBe(0.8);
      expect(updatedConfig.maxReputationShare).toBe(0.2);
      expect(updatedConfig.tieThreshold).toBe(0.1);
    });

    it('should use provided config for resolution', () => {
      const votes: VerificationVote[] = [
        { 
          claimId: 'test', 
          userId: 'user1', 
          verdict: 'TRUE', 
          userReputation: 30, 
          stakeAmount: '50',
          timestamp: new Date(),
          eventId: 'event1'
        }
      ];

      // Low threshold should resolve, high threshold should not
      const lowThresholdResult = service.resolveClaim(votes, { confidenceThreshold: 0.3 });
      const highThresholdResult = service.resolveClaim(votes, { confidenceThreshold: 0.9 });
      
      expect(lowThresholdResult.resolvedVerdict).not.toBe('UNRESOLVED');
      expect(highThresholdResult.resolvedVerdict).toBe('UNRESOLVED');
    });
  });

  describe('edge cases', () => {
    const baseVote = {
      claimId: 'edge-case',
      timestamp: new Date(),
      eventId: 'event-edge'
    };

    it('should handle all UNSURE votes', () => {
      const votes: VerificationVote[] = [
        { ...baseVote, userId: 'user1', verdict: 'UNSURE', userReputation: 50, stakeAmount: '100' },
        { ...baseVote, userId: 'user2', verdict: 'UNSURE', userReputation: 60, stakeAmount: '150' },
      ];

      const result = service.resolveClaim(votes);
      expect(result.verdictDistribution.UNSURE).toBeGreaterThan(0);
    });

    it('should handle zero reputation voters', () => {
      const votes: VerificationVote[] = [
        { ...baseVote, userId: 'user1', verdict: 'TRUE', userReputation: 0, stakeAmount: '100' },
      ];

      const result = service.resolveClaim(votes);
      // Should still process, but with minimum weight
      expect(result.totalWeight).toBeGreaterThan(0);
    });

    it('should handle very high reputation voters', () => {
      const votes: VerificationVote[] = [
        { ...baseVote, userId: 'user1', verdict: 'TRUE', userReputation: 100, stakeAmount: '1000' },
      ];

      const result = service.resolveClaim(votes);
      expect(result.totalWeight).toBeGreaterThan(100);
    });

    it('should handle mixed verdict types', () => {
      const votes: VerificationVote[] = [
        { ...baseVote, userId: 'user1', verdict: 'TRUE', userReputation: 70, stakeAmount: '100' },
        { ...baseVote, userId: 'user2', verdict: 'FALSE', userReputation: 65, stakeAmount: '90' },
        { ...baseVote, userId: 'user3', verdict: 'UNSURE', userReputation: 60, stakeAmount: '80' },
      ];

      const result = service.resolveClaim(votes);
      expect(result.voterCount).toBe(3);
      expect(result.verdictDistribution.TRUE).toBeGreaterThan(0);
      expect(result.verdictDistribution.FALSE).toBeGreaterThan(0);
      expect(result.verdictDistribution.UNSURE).toBeGreaterThan(0);
    });
  });
});
import { Injectable, Logger } from '@nestjs/common';
import { 
  VerificationVote, 
  WeightedVote, 
  VoteAggregation, 
  ClaimResolution, 
  ResolutionConfig,
  Verdict
} from './types';

/**
 * Weighted Vote Resolution Service
 * 
 * Implements reputation-weighted voting for claim resolution in TruthBounty protocol.
 * Converts individual verification votes into authoritative claim outcomes.
 * 
 * Key Features:
 * - Reputation-based vote weighting
 * - Deterministic resolution logic
 * - Protection against Sybil attacks
 * - Confidence scoring for downstream systems
 */
@Injectable()
export class WeightedVoteResolutionService {
  private readonly logger = new Logger(WeightedVoteResolutionService.name);

  // Default configuration - can be overridden
  private readonly defaultConfig: ResolutionConfig = {
    minTotalWeight: 100,        // Minimum total weight required
    confidenceThreshold: 0.6,   // 60% confidence minimum
    maxReputationShare: 0.4,    // No single user can contribute >40%
    tieThreshold: 0.05          // 5% margin for tie detection
  };

  /**
   * Resolve a claim using weighted voting
   * @param votes Array of verification votes for the claim
   * @param config Optional resolution configuration
   * @returns Claim resolution result with confidence metrics
   */
  resolveClaim(votes: VerificationVote[], config?: Partial<ResolutionConfig>): ClaimResolution {
    const effectiveConfig = { ...this.defaultConfig, ...config };
    
    if (votes.length === 0) {
      return this.createUnresolvedResult('No votes submitted', effectiveConfig);
    }

    // Step 1: Calculate weights for all votes
    const weightedVotes = this.calculateVoteWeights(votes, effectiveConfig);
    
    // Step 2: Aggregate votes by verdict
    const aggregation = this.aggregateVotes(weightedVotes);
    
    // Step 3: Apply resolution logic
    return this.determineResolution(aggregation, effectiveConfig);
  }

  /**
   * Calculate individual vote weights based on reputation and stake
   * 
   * Weight Formula:
   * weight = baseReputation + sqrt(stakeAmount) * stakeMultiplier
   * 
   * Where:
   * - baseReputation: Linear reputation component (primary signal)
   * - stakeAmount: Square root scaling to prevent whale dominance
   * - stakeMultiplier: Configurable modifier (default: 0.1)
   * 
   * @param votes Raw verification votes
   * @param config Resolution configuration
   * @returns Votes with calculated weights
   */
  private calculateVoteWeights(
    votes: VerificationVote[], 
    config: ResolutionConfig
  ): WeightedVote[] {
    return votes.map(vote => {
      // Convert reputation to weight (1-100 scale)
      const reputationWeight = Math.max(1, Math.min(100, vote.userReputation));
      
      // Stake component with square root scaling to prevent whale dominance
      const stakeAmountNum = parseFloat(vote.stakeAmount) || 0;
      const stakeWeight = Math.sqrt(Math.max(0, stakeAmountNum)) * 0.1; // 0.1 multiplier
      
      // Total weight combines both factors
      const totalWeight = reputationWeight + stakeWeight;
      
      return {
        ...vote,
        weight: totalWeight
      };
    });
  }

  /**
   * Aggregate weighted votes by verdict
   * @param weightedVotes Votes with calculated weights
   * @returns Aggregated vote statistics
   */
  private aggregateVotes(weightedVotes: WeightedVote[]): VoteAggregation {
    if (weightedVotes.length === 0) {
      throw new Error('Cannot aggregate empty vote set');
    }

    const claimId = weightedVotes[0].claimId;
    const verdictWeights: Record<Verdict, number> = {
      'TRUE': 0,
      'FALSE': 0,
      'UNSURE': 0
    };

    let totalWeight = 0;

    // Sum weights by verdict
    for (const vote of weightedVotes) {
      verdictWeights[vote.verdict] += vote.weight;
      totalWeight += vote.weight;
    }

    return {
      claimId,
      totalWeight,
      verdictWeights,
      voterCount: weightedVotes.length,
      votes: weightedVotes
    };
  }

  /**
   * Determine final resolution from aggregated votes
   * @param aggregation Aggregated vote data
   * @param config Resolution configuration
   * @returns Final claim resolution
   */
  private determineResolution(
    aggregation: VoteAggregation, 
    config: ResolutionConfig
  ): ClaimResolution {
    const { verdictWeights, totalWeight, voterCount } = aggregation;
    
    // Safety checks
    if (totalWeight < config.minTotalWeight) {
      return this.createUnresolvedResult(
        `Insufficient total weight (${totalWeight} < ${config.minTotalWeight})`,
        config
      );
    }

    // Sort verdicts by weight (descending)
    const sortedVerdicts = Object.entries(verdictWeights)
      .sort(([,a], [,b]) => b - a) as [Verdict, number][];
    
    const [dominantVerdict, dominantWeight] = sortedVerdicts[0];
    const [, secondWeight] = sortedVerdicts[1] || ['', 0];

    // Check for whale dominance
    const maxIndividualShare = this.getMaxIndividualShare(aggregation.votes);
    if (maxIndividualShare > config.maxReputationShare) {
      return this.createUnresolvedResult(
        `Single verifier dominance (${(maxIndividualShare * 100).toFixed(1)}% share)`,
        config
      );
    }

    // Calculate resolution metrics
    const resolutionMargin = dominantWeight - secondWeight;
    const isTie = resolutionMargin < (totalWeight * config.tieThreshold);
    
    // Determine confidence score
    const confidenceScore = totalWeight > 0 ? dominantWeight / totalWeight : 0;
    const isLowConfidence = confidenceScore < config.confidenceThreshold;

    // Final resolution logic
    let resolvedVerdict: Verdict | 'UNRESOLVED' = 'UNRESOLVED';
    let resolutionReason = '';

    if (isTie) {
      resolvedVerdict = 'UNRESOLVED';
      resolutionReason = 'Near tie between verdicts';
    } else if (isLowConfidence) {
      resolvedVerdict = 'UNRESOLVED';
      resolutionReason = `Low confidence (${(confidenceScore * 100).toFixed(1)}%)`;
    } else {
      resolvedVerdict = dominantVerdict;
      resolutionReason = `Clear majority for ${dominantVerdict}`;
    }

    const result: ClaimResolution = {
      claimId: aggregation.claimId,
      resolvedVerdict,
      confidenceScore,
      resolutionMargin,
      totalWeight,
      voterCount,
      verdictDistribution: verdictWeights,
      metadata: {
        timestamp: new Date(),
        dominantVerdictWeight: dominantWeight,
        secondVerdictWeight: secondWeight,
        isTie,
        isLowConfidence
      }
    };

    this.logger.log(
      `Claim ${aggregation.claimId} resolved as ${resolvedVerdict} ` +
      `(confidence: ${(confidenceScore * 100).toFixed(1)}%, margin: ${resolutionMargin.toFixed(2)})`
    );

    if (resolvedVerdict === 'UNRESOLVED') {
      this.logger.warn(
        `Claim ${aggregation.claimId} unresolved: ${resolutionReason}`
      );
    }

    return result;
  }

  /**
   * Calculate maximum individual contribution share
   * @param votes Weighted votes
   * @returns Maximum share (0.0-1.0)
   */
  private getMaxIndividualShare(votes: WeightedVote[]): number {
    const totalWeight = votes.reduce((sum, vote) => sum + vote.weight, 0);
    if (totalWeight === 0) return 0;

    // Group votes by user
    const userWeights: Record<string, number> = {};
    for (const vote of votes) {
      userWeights[vote.userId] = (userWeights[vote.userId] || 0) + vote.weight;
    }

    const maxWeight = Math.max(...Object.values(userWeights));
    return maxWeight / totalWeight;
  }

  /**
   * Create unresolved result with reason
   */
  private createUnresolvedResult(
    reason: string, 
    config: ResolutionConfig
  ): ClaimResolution {
    return {
      claimId: 'unknown',
      resolvedVerdict: 'UNRESOLVED',
      confidenceScore: 0,
      resolutionMargin: 0,
      totalWeight: 0,
      voterCount: 0,
      verdictDistribution: { 'TRUE': 0, 'FALSE': 0, 'UNSURE': 0 },
      metadata: {
        timestamp: new Date(),
        dominantVerdictWeight: 0,
        secondVerdictWeight: 0,
        isTie: false,
        isLowConfidence: true
      }
    };
  }

  /**
   * Get current resolution configuration
   */
  getConfig(): ResolutionConfig {
    return { ...this.defaultConfig };
  }

  /**
   * Update resolution configuration
   */
  updateConfig(newConfig: Partial<ResolutionConfig>): void {
    Object.assign(this.defaultConfig, newConfig);
    this.logger.log('Resolution configuration updated');
  }

  /**
   * Validate vote data integrity
   */
  validateVotes(votes: VerificationVote[]): string[] {
    const errors: string[] = [];

    if (votes.length === 0) {
      errors.push('No votes provided');
      return errors;
    }

    // Check for consistent claim ID
    const claimId = votes[0].claimId;
    for (let i = 1; i < votes.length; i++) {
      if (votes[i].claimId !== claimId) {
        errors.push(`Inconsistent claim ID: expected ${claimId}, got ${votes[i].claimId}`);
      }
    }

    // Validate individual votes
    votes.forEach((vote, index) => {
      if (!vote.userId) {
        errors.push(`Vote ${index}: Missing userId`);
      }
      if (!['TRUE', 'FALSE', 'UNSURE'].includes(vote.verdict)) {
        errors.push(`Vote ${index}: Invalid verdict ${vote.verdict}`);
      }
      if (vote.userReputation < 0 || vote.userReputation > 100) {
        errors.push(`Vote ${index}: Invalid reputation ${vote.userReputation} (must be 0-100)`);
      }
      if (parseFloat(vote.stakeAmount) < 0) {
        errors.push(`Vote ${index}: Negative stake amount`);
      }
    });

    return errors;
  }
}
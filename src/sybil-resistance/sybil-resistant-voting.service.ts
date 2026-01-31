import { Injectable, Logger } from '@nestjs/common';
import { SybilResistanceService } from '../sybil-resistance/sybil-resistance.service';

/**
 * Sybil-Resistant Voting Integration Service
 * 
 * Bridges Sybil resistance scores with verification voting engines.
 * Applies Sybil score multipliers to vote weights for more Sybil-resistant outcomes.
 */
@Injectable()
export class SybilResistantVotingService {
  private readonly logger = new Logger(SybilResistantVotingService.name);

  constructor(private sybilService: SybilResistanceService) {}

  /**
   * Calculate vote weight with Sybil resistance multiplier
   * 
   * Final weight = base weight * sybil_score_multiplier
   * Where sybil_score_multiplier = 0.5 + (0.5 * sybil_score)
   * 
   * This ensures:
   * - Users with 0 Sybil score get 50% weight reduction
   * - Users with 1.0 Sybil score get full weight
   * - Linear scaling between 0 and 1
   */
  async calculateSybilWeightedVote(
    userId: string,
    baseWeight: number,
  ): Promise<{
    userId: string;
    baseWeight: number;
    sybilScore: number;
    multiplier: number;
    finalWeight: number;
    explanation: string;
  }> {
    const sybilScore = await this.sybilService.getLatestSybilScore(userId);
    
    // Calculate multiplier: ranges from 0.5 to 1.0
    const multiplier = 0.5 + (0.5 * sybilScore.compositeScore);
    const finalWeight = baseWeight * multiplier;

    const explanation = `Vote weight: ${baseWeight.toFixed(2)} base × ${multiplier.toFixed(2)} (Sybil multiplier) = ${finalWeight.toFixed(2)} effective`;

    this.logger.debug(
      `User ${userId}: base=${baseWeight.toFixed(2)}, sybil=${sybilScore.compositeScore.toFixed(2)}, final=${finalWeight.toFixed(2)}`
    );

    return {
      userId,
      baseWeight,
      sybilScore: sybilScore.compositeScore,
      multiplier,
      finalWeight,
      explanation,
    };
  }

  /**
   * Calculate Sybil-weighted votes for a list of voters
   */
  async calculateSybilWeightedVotes(
    votes: Array<{ userId: string; baseWeight: number }>,
  ): Promise<Array<{
    userId: string;
    baseWeight: number;
    sybilScore: number;
    multiplier: number;
    finalWeight: number;
  }>> {
    const results: Array<{
      userId: string;
      baseWeight: number;
      sybilScore: number;
      multiplier: number;
      finalWeight: number;
    }> = [];

    for (const vote of votes) {
      const weighted = await this.calculateSybilWeightedVote(
        vote.userId,
        vote.baseWeight,
      );
      results.push({
        userId: weighted.userId,
        baseWeight: weighted.baseWeight,
        sybilScore: weighted.sybilScore,
        multiplier: weighted.multiplier,
        finalWeight: weighted.finalWeight,
      });
    }

    return results;
  }

  /**
   * Get scoring impact analysis
   * Shows how Sybil resistance affects vote outcomes
   */
  async getVotingImpactAnalysis(
    votes: Array<{ userId: string; verdict: string; baseWeight: number }>,
  ): Promise<{
    originalTotalWeight: number;
    sybilAdjustedTotalWeight: number;
    weightReduction: number;
    percentageChange: string;
    details: Array<{
      userId: string;
      verdict: string;
      baseWeight: number;
      sybilScore: number;
      adjustedWeight: number;
    }>;
  }> {
    let originalTotalWeight = 0;
    let sybilAdjustedTotalWeight = 0;
    const details: Array<{
      userId: string;
      verdict: string;
      baseWeight: number;
      sybilScore: number;
      adjustedWeight: number;
    }> = [];

    for (const vote of votes) {
      originalTotalWeight += vote.baseWeight;

      const weighted = await this.calculateSybilWeightedVote(
        vote.userId,
        vote.baseWeight,
      );

      sybilAdjustedTotalWeight += weighted.finalWeight;

      details.push({
        userId: vote.userId,
        verdict: vote.verdict,
        baseWeight: vote.baseWeight,
        sybilScore: weighted.sybilScore,
        adjustedWeight: weighted.finalWeight,
      });
    }

    const weightReduction = originalTotalWeight - sybilAdjustedTotalWeight;
    const percentageChange = originalTotalWeight > 0
      ? ((weightReduction / originalTotalWeight) * 100).toFixed(2)
      : '0';

    return {
      originalTotalWeight,
      sybilAdjustedTotalWeight,
      weightReduction,
      percentageChange: `${percentageChange}%`,
      details,
    };
  }

  /**
   * Verify if a user meets minimum Sybil score for participation
   */
  async meetsMinimumSybilScore(
    userId: string,
    minimumScore: number = 0.1,
  ): Promise<{
    userId: string;
    currentScore: number;
    minimumRequired: number;
    eligible: boolean;
  }> {
    const sybilScore = await this.sybilService.getLatestSybilScore(userId);

    return {
      userId,
      currentScore: sybilScore.compositeScore,
      minimumRequired: minimumScore,
      eligible: sybilScore.compositeScore >= minimumScore,
    };
  }

  /**
   * Get Sybil-resistant participation eligibility report
   */
  async getParticipationEligibility(
    userIds: string[],
    minimumScore: number = 0.1,
  ): Promise<{
    totalUsers: number;
    eligibleUsers: number;
    ineligibleUsers: number;
    eligibilityRate: string;
    details: Array<{
      userId: string;
      currentScore: number;
      eligible: boolean;
    }>;
  }> {
    const details: Array<{
      userId: string;
      currentScore: number;
      eligible: boolean;
    }> = [];
    let eligibleCount = 0;

    for (const userId of userIds) {
      const result = await this.meetsMinimumSybilScore(userId, minimumScore);
      details.push({
        userId: result.userId,
        currentScore: result.currentScore,
        eligible: result.eligible,
      });

      if (result.eligible) {
        eligibleCount++;
      }
    }

    const eligibilityRate = userIds.length > 0
      ? ((eligibleCount / userIds.length) * 100).toFixed(2)
      : '0';

    return {
      totalUsers: userIds.length,
      eligibleUsers: eligibleCount,
      ineligibleUsers: userIds.length - eligibleCount,
      eligibilityRate: `${eligibilityRate}%`,
      details,
    };
  }
}

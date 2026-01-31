import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Calculation details structure for explainability
 */
interface CalculationDetails {
  worldcoinWeight: number;
  walletAgeWeight: number;
  stakingWeight: number;
  accuracyWeight: number;
  componentScores: {
    worldcoin: number;
    walletAge: number;
    staking: number;
    accuracy: number;
  };
  timestamp: string;
  explanation: string;
}

/**
 * Raw signal data for scoring
 */
interface SybilSignals {
  worldcoinVerified: boolean;
  oldestWalletAgeMs: number;
  totalStakedAmount: bigint;
  claimsVotedOn: number;
  claimsCorrect: number;
}

@Injectable()
export class SybilResistanceService {
  // Weighting constants (should sum to 1.0)
  private readonly WORLDCOIN_WEIGHT = 0.3;
  private readonly WALLET_AGE_WEIGHT = 0.25;
  private readonly STAKING_WEIGHT = 0.25;
  private readonly ACCURACY_WEIGHT = 0.2;

  // Scoring thresholds and normalization constants
  private readonly WALLET_AGE_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
  private readonly MIN_STAKING_FOR_FULL_SCORE = BigInt('1000000000000000000'); // 1 token (assuming 18 decimals)
  private readonly MIN_CLAIMS_FOR_ACCURACY_SCORE = 5;

  constructor(private prisma: PrismaService) {}

  /**
   * Compute Sybil resistance score for a user
   * Combines identity, behavioral, and staking signals
   * Returns a normalized score (0-1)
   */
  async computeSybilScore(userId: string): Promise<{
    score: number;
    details: CalculationDetails;
  }> {
    // 1. Fetch user and all signals
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { wallets: true },
    });

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    // 2. Gather all signals
    const signals = await this.gatherSignals(userId, user.wallets);

    // 3. Normalize each signal to 0-1 range
    const normalizedScores = this.normalizeSignals(signals);

    // 4. Apply weighted combination
    const compositeScore = this.weightedCombination(normalizedScores);

    // 5. Create detailed calculation record
    const details = this.createCalculationDetails(normalizedScores);

    return {
      score: Number(compositeScore.toFixed(4)),
      details,
    };
  }

  /**
   * Gather all signals for a user
   */
  private async gatherSignals(
    userId: string,
    wallets: Array<{ linkedAt: Date }>,
  ): Promise<SybilSignals> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    // Calculate wallet age (use oldest linked wallet)
    const oldestWalletAgeMs = wallets.length > 0
      ? Date.now() - new Date(wallets.reduce((oldest, w) => 
          new Date(w.linkedAt) < new Date(oldest.linkedAt) ? w : oldest
        ).linkedAt).getTime()
      : 0;

    // TODO: Integrate with staking module once available
    // For now, default to 0 total staked amount
    const totalStakedAmount = BigInt(0);

    // TODO: Integrate with claims module for accuracy metrics
    // For now, default to no claims
    const claimsVotedOn = 0;
    const claimsCorrect = 0;

    return {
      worldcoinVerified: user?.worldcoinVerified ?? false,
      oldestWalletAgeMs,
      totalStakedAmount,
      claimsVotedOn,
      claimsCorrect,
    };
  }

  /**
   * Normalize signals to 0-1 range
   */
  private normalizeSignals(signals: SybilSignals): {
    worldcoin: number;
    walletAge: number;
    staking: number;
    accuracy: number;
  } {
    // Worldcoin: binary (0 or 1)
    const worldcoinScore = signals.worldcoinVerified ? 1.0 : 0.0;

    // Wallet Age: sigmoid-like curve with 90-day threshold
    const walletAgeScore = Math.min(
      signals.oldestWalletAgeMs / this.WALLET_AGE_THRESHOLD_MS,
      1.0,
    );

    // Staking: logarithmic scaling to avoid whales dominating
    // Uses log1p to handle 0 gracefully
    const stakingScore = Math.min(
      Math.log1p(Number(signals.totalStakedAmount)) /
        Math.log1p(Number(this.MIN_STAKING_FOR_FULL_SCORE)),
      1.0,
    );

    // Accuracy: ratio of correct votes, with minimum threshold
    let accuracyScore = 0.0;
    if (signals.claimsVotedOn >= this.MIN_CLAIMS_FOR_ACCURACY_SCORE) {
      accuracyScore = signals.claimsCorrect / signals.claimsVotedOn;
    }

    return {
      worldcoin: worldcoinScore,
      walletAge: walletAgeScore,
      staking: stakingScore,
      accuracy: accuracyScore,
    };
  }

  /**
   * Weighted combination of normalized signals
   */
  private weightedCombination(normalizedScores: {
    worldcoin: number;
    walletAge: number;
    staking: number;
    accuracy: number;
  }): number {
    return (
      normalizedScores.worldcoin * this.WORLDCOIN_WEIGHT +
      normalizedScores.walletAge * this.WALLET_AGE_WEIGHT +
      normalizedScores.staking * this.STAKING_WEIGHT +
      normalizedScores.accuracy * this.ACCURACY_WEIGHT
    );
  }

  /**
   * Create detailed calculation record for explainability
   */
  private createCalculationDetails(normalizedScores: {
    worldcoin: number;
    walletAge: number;
    staking: number;
    accuracy: number;
  }): CalculationDetails {
    const composite = this.weightedCombination(normalizedScores);

    return {
      worldcoinWeight: this.WORLDCOIN_WEIGHT,
      walletAgeWeight: this.WALLET_AGE_WEIGHT,
      stakingWeight: this.STAKING_WEIGHT,
      accuracyWeight: this.ACCURACY_WEIGHT,
      componentScores: {
        worldcoin: Number(normalizedScores.worldcoin.toFixed(4)),
        walletAge: Number(normalizedScores.walletAge.toFixed(4)),
        staking: Number(normalizedScores.staking.toFixed(4)),
        accuracy: Number(normalizedScores.accuracy.toFixed(4)),
      },
      timestamp: new Date().toISOString(),
      explanation: `Sybil resistance score calculated from 4 signals:
- Worldcoin verification (${normalizedScores.worldcoin.toFixed(2)}) - Identity proof
- Wallet age (${normalizedScores.walletAge.toFixed(2)}) - Account tenure
- Staking participation (${normalizedScores.staking.toFixed(2)}) - Economic commitment
- Claim accuracy (${normalizedScores.accuracy.toFixed(2)}) - Verification history
Final score: ${Number(composite.toFixed(4))} (weighted average)`,
    };
  }

  /**
   * Store a Sybil score snapshot
   */
  async recordSybilScore(userId: string): Promise<any> {
    const { score: compositeScore, details } = await this.computeSybilScore(userId);

    return this.prisma.sybilScore.create({
      data: {
        userId,
        worldcoinScore: details.componentScores.worldcoin,
        walletAgeScore: details.componentScores.walletAge,
        stakingScore: details.componentScores.staking,
        accuracyScore: details.componentScores.accuracy,
        compositeScore,
        calculationDetails: JSON.stringify(details),
      },
    });
  }

  /**
   * Get the most recent Sybil score for a user
   */
  async getLatestSybilScore(userId: string): Promise<any> {
    const score = await this.prisma.sybilScore.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (!score) {
      // If no score exists, compute one now
      return this.recordSybilScore(userId);
    }

    return score;
  }

  /**
   * Get all Sybil score history for a user
   */
  async getSybilScoreHistory(userId: string, limit: number = 10): Promise<any[]> {
    return this.prisma.sybilScore.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Batch recalculate Sybil scores for verification purposes
   */
  async recalculateAllScores(): Promise<Array<{
    userId: string;
    success: boolean;
    score?: number;
    error?: string;
  }>> {
    const users = await this.prisma.user.findMany();
    const results: Array<{
      userId: string;
      success: boolean;
      score?: number;
      error?: string;
    }> = [];

    for (const user of users) {
      try {
        const scoreRecord = await this.recordSybilScore(user.id);
        results.push({ userId: user.id, success: true, score: scoreRecord.compositeScore });
      } catch (error) {
        results.push({
          userId: user.id,
          success: false,
          error: error.message,
        });
      }
    }

    return results;
  }

  /**
   * Update Worldcoin verification status for a user
   */
  async setWorldcoinVerified(userId: string, verified: boolean): Promise<any> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { worldcoinVerified: verified },
    });

    // Recalculate score after verification status change
    return this.recordSybilScore(userId);
  }

  /**
   * Get Sybil score with metadata for verification/voting engines
   */
  async getSybilScoreForVoting(userId: string): Promise<{
    userId: string;
    score: number;
    isVerified: boolean;
    details: any;
  }> {
    const score = await this.getLatestSybilScore(userId);

    return {
      userId,
      score: score.compositeScore,
      isVerified: score.worldcoinScore > 0,
      details: score.calculationDetails ? JSON.parse(score.calculationDetails) : null,
    };
  }
}

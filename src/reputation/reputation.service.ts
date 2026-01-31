import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { User } from '../entities/user.entity';
import { ReputationChange } from '../entities/reputation-change.entity';
import {
  MAX_SCORE,
  BASE_DELTA,
  STAKE_CAP,
  MIN_DAMPEN,
  MAX_POS_DELTA,
  MAX_NEG_DELTA,
  ALPHA,
  ReputationDeltaParams,
} from './reputation.types';

@Injectable()
export class ReputationService {
  private readonly logger = new Logger(ReputationService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(ReputationChange)
    private readonly changeRepo: Repository<ReputationChange>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Pure, deterministic reputation delta computation.
   * Works in integer domain (scores 0..100) and returns an integer delta.
   */
  computeReputationDelta(params: ReputationDeltaParams): number {
    const { oldScore, totalVerifications, correctVerifications, stakeAmount, isCorrect } = params;

    // 1) stake factor: 1 + floor(log2(1 + min(stake, STAKE_CAP)))
    const stake = Math.max(0, Math.floor(stakeAmount || 0));
    const limitedStake = Math.min(stake, STAKE_CAP);
    const stakeFactor = 1 + Math.floor(Math.log2(1 + limitedStake));

    // 2) reliability factor: Bayesian estimate scaled to 0..100
    const reliabilityNum = (correctVerifications || 0) + ALPHA;
    const reliabilityDen = (totalVerifications || 0) + 2 * ALPHA;
    const reliabilityFactor = Math.floor((reliabilityNum * 100) / reliabilityDen);

    // 3) raw delta
    const raw = Math.floor((BASE_DELTA * stakeFactor * reliabilityFactor) / 100);

    // Ensure at least a minimal effect
    const minimumRaw = Math.max(1, raw);

    let delta = isCorrect ? minimumRaw : -minimumRaw;

    // 4) dampening for positive gains for high-rep users
    if (isCorrect) {
      const dampening = Math.max(MIN_DAMPEN, (MAX_SCORE - oldScore) / MAX_SCORE);
      delta = Math.floor(delta * dampening);
      // delta could drop to 0 due to dampening; ensure small progress
      if (delta === 0) delta = 1;
    } else {
      // incorrect verifications penalize more for higher-rep users
      const amplify = 1 + Math.floor((oldScore) / 50); // 0..2
      delta = -Math.max(1, Math.floor(Math.abs(delta) * amplify));
    }

    // 5) clamp to configured per-update bounds
    if (delta > MAX_POS_DELTA) delta = MAX_POS_DELTA;
    if (delta < -MAX_NEG_DELTA) delta = -MAX_NEG_DELTA;

    return delta;
  }

  /**
   * Apply a single reputation update for a user (transactional optional).
   */
  async applyReputationUpdate(
    userId: string,
    delta: number,
    meta: { stakeAmount?: number; isCorrect?: boolean; verificationId?: string } = {},
  ) {
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, { where: { id: userId } });
      if (!user) {
        this.logger.warn(`User ${userId} not found when applying reputation update`);
        return null;
      }

      const oldScore = Math.max(0, Math.min(MAX_SCORE, Math.floor(user.reputation || 0)));
      const newScore = Math.max(0, Math.min(MAX_SCORE, oldScore + delta));

      user.reputation = newScore;
      await manager.save(user);

      const change = new ReputationChange();
      change.userId = userId;
      change.oldScore = oldScore;
      change.newScore = newScore;
      change.delta = delta;
      change.stakeAmount = meta.stakeAmount ?? null;
      change.isCorrect = !!meta.isCorrect;
      change.verificationId = meta.verificationId ?? null;

      await manager.save(change);

      // Emit internal log for operators
      this.logger.log(
        `Reputation updated user=${userId} old=${oldScore} new=${newScore} delta=${delta} verification=${meta.verificationId}`,
      );

      return { user, change };
    });
  }

  /**
   * Called by aggregation pipeline after a claim is finalized.
   * Updates reputation for each verifier in the supplied list.
   */
  async updateBatchAfterAggregation(
    aggregationResult: { claimId: string; status: string },
    verifications: Array<{
      id: string;
      userId: string;
      verdict: string;
      stakeAmount: number;
      // history fields (if available) used to compute reliability
      verifierTotal?: number;
      verifierCorrect?: number;
    }>,
  ) {
    // perform all updates in a transaction for consistency
    await this.dataSource.transaction(async (manager) => {
      for (const v of verifications) {
        const isCorrect =
          (aggregationResult.status === 'VERIFIED_TRUE' && v.verdict === 'TRUE') ||
          (aggregationResult.status === 'VERIFIED_FALSE' && v.verdict === 'FALSE');

        const oldUser = await manager.findOne(User, { where: { id: v.userId } });
        const oldScore = oldUser ? Math.max(0, Math.min(MAX_SCORE, Math.floor(oldUser.reputation || 0))) : 0;

        const delta = this.computeReputationDelta({
          oldScore,
          totalVerifications: v.verifierTotal ?? 0,
          correctVerifications: v.verifierCorrect ?? 0,
          stakeAmount: v.stakeAmount ?? 0,
          isCorrect,
        });

        // If user missing, skip but still log a warning
        if (!oldUser) {
          this.logger.warn(`Skipping reputation update — user ${v.userId} not found`);
          continue;
        }

        oldUser.reputation = Math.max(0, Math.min(MAX_SCORE, oldScore + delta));
        await manager.save(oldUser);

        const change = new ReputationChange();
        change.userId = v.userId;
        change.oldScore = oldScore;
        change.newScore = oldUser.reputation;
        change.delta = delta;
        change.stakeAmount = v.stakeAmount ?? null;
        change.isCorrect = isCorrect;
        change.verificationId = v.id;

        await manager.save(change);
      }
    });
  }
}

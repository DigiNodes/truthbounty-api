import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { Stake } from '../staking/entities/stake.entity';
import { Wallet } from '../entities/wallet.entity';
import { Claim } from '../claims/entities/claim.entity';
import { User } from '../entities/user.entity';
import { AggregationService } from '../aggregation/aggregation.service';
import { ClaimsCache } from '../cache/claims.cache';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SybilResistanceService } from '../sybil-resistance/sybil-resistance.service';

// ─── Constants ────────────────────────────────────────────────────────────────

const SCORE_BATCH_SIZE = 50;
const REPUTATION_BATCH_SIZE = 100;

/** Confidence threshold (0–100 scale from AggregationService) above which a
 *  claim is considered resolved. Matches original > 50 logic. */
const FINALIZATION_THRESHOLD = 50;

/** Normalises AggregationService confidence (0–100) to the stored 0–1 field. */
const CONFIDENCE_SCALE = 100;

// ─── Internal types ───────────────────────────────────────────────────────────

interface AggregationVerification {
  id: string;
  claimId: string;
  userId: string | null;
  verdict: 'TRUE' | 'FALSE';
  stakeAmount: number;
  reputationWeight: number;
  createdAt: Date;
}

interface BatchResult {
  processed: number;
  updated: number;
  errors: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly redisService: RedisService,
    @InjectRepository(Stake)
    private readonly stakeRepo: Repository<Stake>,
    @InjectRepository(Wallet)
    private readonly walletRepo: Repository<Wallet>,
    @InjectRepository(Claim)
    private readonly claimRepo: Repository<Claim>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly claimsCache: ClaimsCache,
    private readonly aggregationService: AggregationService,
  ) {}

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    this.logger.log('JobsService initialized — BullMQ integration pending');
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('JobsService shutting down');
  }

  // ─── Public job entry-points ────────────────────────────────────────────
  // These will become @Process() handlers once BullMQ is wired in.

  async runComputeScores(): Promise<BatchResult> {
    return this.computeScores();
    @InjectQueue('jobs-queue') private readonly jobsQueue: Queue,
    private readonly sybilResistanceService: SybilResistanceService,
    private readonly aggregationService?: AggregationService,
  ) { }

  async onModuleInit() {
    this.logger.log('JobsService initialized. Registering repeatable BullMQ jobs...');
    try {
      const repeatableJobs = await this.jobsQueue.getRepeatableJobs();
      for (const rJob of repeatableJobs) {
        await this.jobsQueue.removeRepeatableByKey(rJob.key);
      }

      await this.jobsQueue.add(
        'compute-scores',
        {},
        {
          repeat: {
            pattern: '0 * * * *', // hourly
          },
          jobId: 'compute-scores-job',
        },
      );
      await this.jobsQueue.add(
        'compute-reputation',
        {},
        {
          repeat: {
            pattern: '0 0 * * *', // daily
          },
          jobId: 'compute-reputation-job',
        },
      );
      await this.jobsQueue.add(
        'cleanup-sybil-history',
        {},
        {
          repeat: {
            pattern: '0 2 * * *', // daily at 2:00 AM
          },
          jobId: 'cleanup-sybil-history-job',
        },
      );
      this.logger.log('Repeatable BullMQ jobs registered successfully');
    } catch (err) {
      this.logger.error(`Failed to register repeatable BullMQ jobs: ${err.message}`);
    }
  }

  async runComputeReputation(): Promise<BatchResult> {
    return this.computeReputation();
  }

  // ─── computeScores ──────────────────────────────────────────────────────

  /**
   * Process a batch of unfinalized claims, computing an aggregated confidence
   * score from their stakes and marking high-confidence claims as resolved.
   *
   * N+1 pattern eliminated: wallets and users are bulk-fetched per claim batch
   * rather than one DB round-trip per stake.
   */
  private async computeScores(): Promise<BatchResult> {
  async cleanupSybilHistory(): Promise<number> {
    this.logger.debug('cleanupSybilHistory: starting');
    const count = await this.sybilResistanceService.cleanupScoreHistory();
    this.logger.debug(`cleanupSybilHistory: deleted ${count} old records`);
    return count;
  }

  async computeScores() {
    this.logger.debug('computeScores: starting');
    const result: BatchResult = { processed: 0, updated: 0, errors: 0 };

    const claims = await this.claimRepo.find({
      where: { finalized: false },
      take: SCORE_BATCH_SIZE,
    });

    if (claims.length === 0) {
      this.logger.debug('computeScores: no unfinalized claims found');
      return result;
    }

    // Bulk-load all stakes for this batch in one query
    const claimIds = claims.map((c) => c.id);
    const allStakes = await this.stakeRepo.find({
      where: { claimId: In(claimIds) },
    });

    // Group stakes by claimId for O(1) lookup
    const stakesByClaimId = groupBy(allStakes, (s) => s.claimId);

    // Bulk-load wallets and users referenced in this batch
    const walletAddresses = [...new Set(allStakes.map((s) => s.walletAddress))];
    const wallets = walletAddresses.length
      ? await this.walletRepo.find({ where: { address: In(walletAddresses) } })
      : [];

    const walletByAddress = indexBy(wallets, (w) => w.address);

    const userIds = [...new Set(wallets.map((w) => w.userId).filter(Boolean))];
    const users = userIds.length
      ? await this.userRepo.find({ where: { id: In(userIds) } })
      : [];

    const userById = indexBy(users, (u) => u.id);

    // Process each claim
    for (const claim of claims) {
      result.processed++;
      try {
        const stakes = stakesByClaimId.get(claim.id) ?? [];

        if (stakes.length === 0) {
          this.logger.debug(`Claim ${claim.id}: no stakes — marking inconclusive`);
          claim.confidenceScore = 0;
          await this.claimRepo.save(claim);
          result.updated++;
          continue;
        }

        const verifications = this.buildVerifications(
          claim.id,
          stakes,
          walletByAddress,
          userById,
        );

        const agg = this.aggregationService.aggregate(claim.id, verifications);
        const wasFinalized = claim.finalized;

        claim.confidenceScore = agg.confidence / CONFIDENCE_SCALE;

        if (agg.confidence > FINALIZATION_THRESHOLD) {
          claim.finalized = true;
          claim.resolvedVerdict = agg.status === 'VERIFIED_TRUE';
        const updateFields: Partial<Claim> = {
          confidenceScore: result.confidence / 100,
        };

        if (result.confidence > 50) {
          updateFields.finalized = true;
          updateFields.resolvedVerdict = result.status === 'VERIFIED_TRUE';
        }

        const updated = await this.tryUpdateClaimIfNotFinalized(claim.id, updateFields);

        if (!updated) {
          this.logger.debug(
            `Claim ${claim.id} was updated by a concurrent worker; skipping stale aggregation write`,
          );
          continue;
        }

        await this.claimsCache.invalidateClaim(claim.id);
        result.updated++;

        this.logger.log(
          `Claim ${claim.id}: confidence=${claim.confidenceScore.toFixed(4)}` +
            (claim.finalized && !wasFinalized
              ? `, finalized → verdict=${claim.resolvedVerdict}`
              : ''),
        );
        this.logger.log(`Updated claim ${claim.id} confidence=${updateFields.confidenceScore}`);
      } catch (err) {
        result.errors++;
        this.logger.error(
          `computeScores: error on claim ${claim.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    this.logger.debug(
      `computeScores: finished — processed=${result.processed} updated=${result.updated} errors=${result.errors}`,
    );
    return result;
  }

  async computeReputation() {
  private async tryUpdateClaimIfNotFinalized(
    claimId: string,
    updateFields: Partial<Claim>,
  ): Promise<boolean> {
    const result = await this.claimRepo
      .createQueryBuilder()
      .update(Claim)
      .set(updateFields)
      .where('id = :id', { id: claimId })
      .andWhere('finalized = false')
      .execute();

    return (result.affected ?? 0) > 0;
  }

  private async computeReputation() {
    this.logger.debug('computeReputation: starting');
    const result: BatchResult = { processed: 0, updated: 0, errors: 0 };

    const users = await this.userRepo.find({ take: REPUTATION_BATCH_SIZE });
    if (users.length === 0) {
      this.logger.debug('computeReputation: no users found');
      return result;
    }

    const userIds = users.map((u) => u.id);

    // Bulk-load wallets for all users in this batch
    const wallets = await this.walletRepo.find({
      where: { userId: In(userIds) },
    });

    const walletsByUserId = groupBy(wallets, (w) => w.userId);
    const allAddresses = wallets.map((w) => w.address);

    if (allAddresses.length === 0) {
      this.logger.debug('computeReputation: no wallets found for batch');
      return result;
    }

    // Bulk-load all stakes for these wallets
    const allStakes = await this.stakeRepo
      .createQueryBuilder('s')
      .where('s.walletAddress IN (:...addrs)', { addrs: allAddresses })
      .getMany();

    const stakesByWalletAddress = groupBy(allStakes, (s) => s.walletAddress);

    // Bulk-load only finalized claims with a non-null verdict
    const stakedClaimIds = [...new Set(allStakes.map((s) => s.claimId))];
    const finalizedClaims =
      stakedClaimIds.length > 0
        ? await this.claimRepo.find({
            where: {
              id: In(stakedClaimIds),
              finalized: true,
              resolvedVerdict: Not(IsNull()),
            },
          })
        : [];

    const claimById = indexBy(finalizedClaims, (c) => c.id);

    // Process each user
    for (const user of users) {
      result.processed++;
      try {
        const userWallets = walletsByUserId.get(user.id) ?? [];
        if (userWallets.length === 0) continue;

        let claimsVotedOn = 0;
        let claimsCorrect = 0;

        for (const wallet of userWallets) {
          const stakes = stakesByWalletAddress.get(wallet.address) ?? [];
          for (const stake of stakes) {
            const claim = claimById.get(stake.claimId);
            if (!claim) continue; // not finalized or no verdict

            claimsVotedOn++;
            if (this.deriveVotedTrue(stake) === Boolean(claim.resolvedVerdict)) {
              claimsCorrect++;
            }
          }
        }

        if (claimsVotedOn === 0) continue;

        const newReputation = Math.round((claimsCorrect / claimsVotedOn) * 100);

        if (user.reputation !== newReputation) {
          user.reputation = newReputation;
          await this.userRepo.save(user);
          result.updated++;
          this.logger.log(
            `User ${user.id}: reputation ${user.reputation} → ${newReputation}`,
          );
        }
      } catch (err) {
        result.errors++;
        this.logger.error(
          `computeReputation: error on user ${user.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    this.logger.debug(
      `computeReputation: finished — processed=${result.processed} updated=${result.updated} errors=${result.errors}`,
    );
    return result;
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private buildVerifications(
    claimId: string,
    stakes: Stake[],
    walletByAddress: Map<string, Wallet>,
    userById: Map<string, User>,
  ): AggregationVerification[] {
    return stakes.map((stake) => {
      const wallet = walletByAddress.get(stake.walletAddress);
      const user = wallet ? userById.get(wallet.userId) : null;

      const stakeAmount =
        typeof (stake as any).amount === 'string'
          ? parseFloat((stake as any).amount)
          : Number((stake as any).amount ?? 0);

      const reputationWeight = user
        ? Math.max(0, Math.min(1, (user.reputation ?? 0) / 100))
        : 0;

      return {
        id: stake.id,
        claimId,
        userId: user?.id ?? null,
        verdict: 'TRUE',
        stakeAmount,
        reputationWeight,
        createdAt: (stake as any).updatedAt ?? new Date(),
      };
    });
  }

  /**
   * Derives whether a stake represents a TRUE vote.
   * Currently all stakes are treated as TRUE; extend this once stakes carry
   * an explicit `verdict` field.
   */
  private deriveVotedTrue(_stake: Stake): boolean {
    return true;
  }
}

// ─── Utility functions ────────────────────────────────────────────────────────

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = map.get(key);
    if (group) group.push(item);
    else map.set(key, [item]);
  }
  return map;
}

function indexBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(keyFn(item), item);
  return map;
}
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
import { Claim, ClaimState } from '../claims/entities/claim.entity';
import { User } from '../entities/user.entity';
import { AggregationService } from '../aggregation/aggregation.service';
import {
  ClaimStatus,
  VerificationVerdict,
} from '../aggregation/aggregation.types';
import { ClaimsCache } from '../cache/claims.cache';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, JobsOptions, Queue } from 'bullmq';
import { SybilResistanceService } from '../sybil-resistance/sybil-resistance.service';
import { Cron } from '@nestjs/schedule';
import {
  DEFAULT_RETRY_POLICY,
  JobName,
  JobOptions,
  JobPriority,
  QueueMetrics,
  QueueName,
} from './jobs.types';

const SCORE_BATCH_SIZE = 50;
const REPUTATION_BATCH_SIZE = 100;
const FINALIZATION_THRESHOLD = 50;
const CONFIDENCE_SCALE = 100;

interface AggregationVerification {
  id: string;
  claimId: string;
  userId: string;
  verdict: VerificationVerdict;
  stakeAmount: number;
  reputationWeight: number;
  createdAt: Date;
}

interface BatchResult {
  processed: number;
  updated: number;
  errors: number;
}

@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private readonly queues = new Map<QueueName, Queue>();

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
    private readonly sybilResistanceService: SybilResistanceService,
    @InjectQueue(QueueName.DEFAULT) private readonly defaultQueue: Queue,
    @InjectQueue(QueueName.NOTIFICATIONS)
    private readonly notificationsQueue: Queue,
    @InjectQueue(QueueName.BLOCKCHAIN) private readonly blockchainQueue: Queue,
    @InjectQueue(QueueName.ANALYTICS) private readonly analyticsQueue: Queue,
  ) {
    this.queues.set(QueueName.DEFAULT, this.defaultQueue);
    this.queues.set(QueueName.NOTIFICATIONS, this.notificationsQueue);
    this.queues.set(QueueName.BLOCKCHAIN, this.blockchainQueue);
    this.queues.set(QueueName.ANALYTICS, this.analyticsQueue);
  }

  async onModuleInit(): Promise<void> {
    await Promise.resolve();
    this.logger.log('JobsService initialized with BullMQ queues');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.resolve();
    this.logger.log('JobsService shutting down');
  }

  async enqueue<T = unknown>(
    name: JobName,
    data: T,
    options: JobOptions = {},
    queueName: QueueName = QueueName.DEFAULT,
  ): Promise<Job<T> | null> {
    const queue = this.getQueue(queueName);
    if (!queue) {
      this.logger.error(`Queue ${queueName} not found`);
      return null;
    }

    const priority = options.priority ?? JobPriority.NORMAL;
    const attempts = options.attempts ?? DEFAULT_RETRY_POLICY.attempts;
    const backoffDelay =
      options.backoffDelay ?? DEFAULT_RETRY_POLICY.backoff.delay;

    try {
      const job = await queue.add(name, data, {
        priority,
        delay: options.delay,
        attempts,
        backoff: {
          type: 'exponential',
          delay: backoffDelay,
        },
      });
      this.logger.log(`Enqueued job ${name} (id: ${job.id}) on ${queueName}`);
      return job as Job<T>;
    } catch (error) {
      this.logger.error(
        `Failed to enqueue job ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async scheduleRecurring<T = unknown>(
    name: JobName,
    data: T,
    cron: string,
    queueName: QueueName = QueueName.DEFAULT,
  ): Promise<Job<T> | null> {
    const queue = this.getQueue(queueName);
    if (!queue) return null;

    const options: JobsOptions = {
      repeat: { pattern: cron },
      attempts: DEFAULT_RETRY_POLICY.attempts,
      backoff: DEFAULT_RETRY_POLICY.backoff,
    };

    try {
      const job = await queue.add(name, data, options);
      this.logger.log(`Scheduled recurring job ${name} with cron ${cron}`);
      return job as Job<T>;
    } catch (error) {
      this.logger.error(
        `Failed to schedule recurring job ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  @Cron('0 */1 * * *')
  async runHourlyMaintenance(): Promise<void> {
    this.logger.log('Hourly maintenance cron triggered');
    await this.enqueue(
      JobName.COMPUTE_SCORES,
      {},
      { priority: JobPriority.NORMAL },
    );
    await this.enqueue(
      JobName.COMPUTE_REPUTATION,
      {},
      { priority: JobPriority.NORMAL },
    );
    await this.enqueue(
      JobName.CLEANUP_SYBIL_HISTORY,
      {},
      { priority: JobPriority.LOW },
    );
  }

  async retryFailed(queueName: QueueName): Promise<number> {
    const queue = this.getQueue(queueName);
    if (!queue) return 0;

    const failed = await queue.getFailed();
    let retried = 0;
    for (const job of failed) {
      try {
        await job.retry();
        retried++;
      } catch (error) {
        this.logger.warn(`Failed to retry job ${job.id}: ${error}`);
      }
    }
    return retried;
  }

  async cancelJob(queueName: QueueName, jobId: string): Promise<boolean> {
    const queue = this.getQueue(queueName);
    if (!queue) return false;

    const job = await queue.getJob(jobId);
    if (!job) return false;

    await job.remove();
    return true;
  }

  async pauseQueue(queueName: QueueName): Promise<void> {
    const queue = this.getQueue(queueName);
    if (queue) await queue.pause();
  }

  async resumeQueue(queueName: QueueName): Promise<void> {
    const queue = this.getQueue(queueName);
    if (queue) await queue.resume();
  }

  async getQueueMetrics(queueName: QueueName): Promise<QueueMetrics | null> {
    const queue = this.getQueue(queueName);
    if (!queue) return null;

    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
    );

    return {
      name: queueName,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      paused: Boolean(counts.paused),
    };
  }

  async getAllQueueMetrics(): Promise<QueueMetrics[]> {
    const results = await Promise.all(
      Array.from(this.queues.keys()).map((name) => this.getQueueMetrics(name)),
    );
    return results.filter((m): m is QueueMetrics => m !== null);
  }

  async runComputeScores(): Promise<BatchResult> {
    return this.computeScores();
  }

  async runComputeReputation(): Promise<BatchResult> {
    return this.computeReputation();
  }

  async cleanupSybilHistory(): Promise<number> {
    this.logger.debug('cleanupSybilHistory: starting');
    const count = await this.sybilResistanceService.cleanupScoreHistory();
    this.logger.debug(`cleanupSybilHistory: deleted ${count} old records`);
    return count;
  }

  private async computeScores(): Promise<BatchResult> {
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

    const claimIds = claims.map((c) => c.id);
    const allStakes = await this.stakeRepo.find({
      where: { claimId: In(claimIds) },
    });

    const stakesByClaimId = groupBy(allStakes, (s) => s.claimId);

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

    for (const claim of claims) {
      result.processed++;
      try {
        const stakes = stakesByClaimId.get(claim.id) ?? [];

        if (stakes.length === 0) {
          this.logger.debug(
            `Claim ${claim.id}: no stakes — marking inconclusive`,
          );
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
          claim.transitionTo(ClaimState.FINALIZED, {
            verdict: agg.status === ClaimStatus.VERIFIED_TRUE,
            confidence: claim.confidenceScore,
          });
        }

        await this.claimRepo.save(claim);
        await this.claimsCache.invalidateClaim(claim.id);
        result.updated++;

        this.logger.log(
          `Claim ${claim.id}: confidence=${claim.confidenceScore.toFixed(4)}` +
            (claim.finalized && !wasFinalized
              ? `, finalized → verdict=${claim.resolvedVerdict}`
              : ''),
        );
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

  private async computeReputation(): Promise<BatchResult> {
    this.logger.debug('computeReputation: starting');
    const result: BatchResult = { processed: 0, updated: 0, errors: 0 };

    const users = await this.userRepo.find({ take: REPUTATION_BATCH_SIZE });
    if (users.length === 0) {
      this.logger.debug('computeReputation: no users found');
      return result;
    }

    const userIds = users.map((u) => u.id);

    const wallets = await this.walletRepo.find({
      where: { userId: In(userIds) },
    });

    const walletsByUserId = groupBy(wallets, (w) => w.userId);
    const allAddresses = wallets.map((w) => w.address);

    if (allAddresses.length === 0) {
      this.logger.debug('computeReputation: no wallets found for batch');
      return result;
    }

    const allStakes = await this.stakeRepo
      .createQueryBuilder('s')
      .where('s.walletAddress IN (:...addrs)', { addrs: allAddresses })
      .getMany();

    const stakesByWalletAddress = groupBy(allStakes, (s) => s.walletAddress);

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
            if (!claim) continue;

            claimsVotedOn++;
            if (
              this.deriveVotedTrue(stake) === Boolean(claim.resolvedVerdict)
            ) {
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

  private getQueue(name: QueueName): Queue | undefined {
    return this.queues.get(name);
  }

  private buildVerifications(
    claimId: string,
    stakes: Stake[],
    walletByAddress: Map<string, Wallet>,
    userById: Map<string, User>,
  ): AggregationVerification[] {
    return stakes.map((stake) => {
      const wallet = walletByAddress.get(stake.walletAddress);
      const user = wallet ? userById.get(wallet.userId) : null;

      const rawAmount = (stake as unknown as { amount?: string | number })
        .amount;
      const stakeAmount =
        typeof rawAmount === 'string'
          ? parseFloat(rawAmount)
          : Number(rawAmount ?? 0);

      const reputationWeight = user
        ? Math.max(0, Math.min(1, (user.reputation ?? 0) / 100))
        : 0;

      return {
        id: stake.id,
        claimId,
        userId: user?.id ?? '',
        verdict: VerificationVerdict.TRUE,
        stakeAmount,
        reputationWeight,
        createdAt:
          (stake as unknown as { updatedAt?: Date }).updatedAt ?? new Date(),
      };
    });
  }

  private deriveVotedTrue(_stake: Stake): boolean {
    void _stake;
    return true;
  }
}

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

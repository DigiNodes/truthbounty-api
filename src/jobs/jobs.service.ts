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
    // Only run cleanup jobs - compute scores/reputation removed in V2
    // (no backend-authoritative claim finalization allowed)
    await this.enqueue(
      JobName.CLEANUP_SYBIL_HISTORY,
      {},
      { priority: JobPriority.NORMAL },
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

  async cleanupSybilHistory(): Promise<number> {
    this.logger.debug('cleanupSybilHistory: starting');
    const count = await this.sybilResistanceService.cleanupScoreHistory();
    this.logger.debug(`cleanupSybilHistory: deleted ${count} old records`);
    return count;
  }

  // V2 Architecture: computeScores and computeReputation methods removed
  // These methods previously contained backend-authoritative logic that
  // automatically finalized claims based on backend calculations.
  // In V2, all claim state transitions must come from on-chain events
  // projected by the V2 projectors, not from backend calculations.

  private getQueue(name: QueueName): Queue | undefined {
    return this.queues.get(name);
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
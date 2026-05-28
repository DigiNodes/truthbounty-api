import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Stake } from '../staking/entities/stake.entity';
import { Wallet } from '../entities/wallet.entity';
import { Claim } from '../claims/entities/claim.entity';
import { User } from '../entities/user.entity';
import { AggregationService } from '../aggregation/aggregation.service';
import { ClaimsCache } from '../cache/claims.cache';
import { AuditRetentionService } from './audit-retention.service';

/**
 * JobsService
 * - Placeholder for scheduled jobs (scores, reputation)
 * - Awaiting bullmq dependency resolution
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    private readonly auditRetentionService: AuditRetentionService,
    @InjectRepository(Stake)
    private readonly stakeRepo: Repository<Stake>,
    @InjectRepository(Wallet)
    private readonly walletRepo: Repository<Wallet>,
    @InjectRepository(Claim)
    private readonly claimRepo: Repository<Claim>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly claimsCache: ClaimsCache,
    private readonly aggregationService?: AggregationService,
  ) { }

  async onModuleInit() {
    this.logger.log('JobsService initialized (bullmq to be integrated)');
  }

  async onModuleDestroy() {
    this.logger.log('JobsService shutdown');
  }

  private async computeScores() {
    this.logger.debug('computeScores: starting');

    // Process claims in small batches
    const batchSize = 50;
    const claims = await this.claimRepo.find({ where: { finalized: false }, take: batchSize });

    for (const claim of claims) {
      try {
        const stakes = await this.stakeRepo.find({ where: { claimId: claim.id } });

        if (!stakes || stakes.length === 0) {
          this.logger.debug(`No stakes for claim ${claim.id}, marking inconclusive`);
          claim.confidenceScore = 0;
          await this.claimRepo.save(claim);
          continue;
        }

        // Build aggregation compatible verifications
        const verifications = [] as any[];

        for (const s of stakes) {
          const wallet = await this.walletRepo.findOneBy({ address: s.walletAddress });
          const user = wallet ? await this.userRepo.findOneBy({ id: wallet.userId }) : null;

          const stakeAmount = typeof (s as any).amount === 'string' ? parseFloat((s as any).amount) : Number((s as any).amount || 0);
          const reputationWeight = user ? Math.max(0, Math.min(1, (user.reputation || 0) / 100)) : 0;

          verifications.push({
            id: (s as any).id,
            claimId: claim.id,
            userId: user?.id || null,
            verdict: 'TRUE',
            stakeAmount,
            reputationWeight,
            createdAt: (s as any).updatedAt || new Date(),
          });
        }

        const agg = this.aggregationService ?? new AggregationService();
        const result = agg.aggregate(claim.id, verifications);

        claim.confidenceScore = result.confidence / 100; // store as 0-1 precision field

        // If strong confidence, mark finalized and set resolvedVerdict
        if (result.confidence > 50) {
          claim.finalized = true;
          // Assume result.status is 'VERIFIED_TRUE' or 'VERIFIED_FALSE'
          // Parse enum name to boolean (VERIFIED_TRUE -> true)
          if (typeof result.status === 'string') {
            claim.resolvedVerdict = result.status === 'VERIFIED_TRUE';
          }
        }

        await this.claimRepo.save(claim);
        await this.claimsCache.invalidateClaim(claim.id);
        this.logger.log(`Updated claim ${claim.id} confidence=${claim.confidenceScore}`);
      } catch (err) {
        this.logger.error(`Error processing claim ${claim.id}: ${err?.message || err}`);
      }
    }

    this.logger.debug('computeScores: finished');
  }

  private async computeReputation() {
    this.logger.debug('computeReputation: starting');

    // Process users in batches
    const batchSize = 100;
    const users = await this.userRepo.find({ take: batchSize });

    for (const user of users) {
      try {
        // Find wallets for user
        const wallets = await this.walletRepo.find({ where: { userId: user.id } });
        if (!wallets || wallets.length === 0) continue;

        const walletAddresses = wallets.map((w) => w.address);

        // Find stakes by these wallets on claims that are finalized
        const stakes = await this.stakeRepo
          .createQueryBuilder('s')
          .where('s.walletAddress IN (:...addrs)', { addrs: walletAddresses })
          .getMany();

        if (!stakes || stakes.length === 0) continue;

        let claimsVotedOn = 0;
        let claimsCorrect = 0;

        for (const s of stakes) {
          const claim = await this.claimRepo.findOneBy({ id: s.claimId });
          if (!claim || !claim.finalized || claim.resolvedVerdict === null) continue;

          claimsVotedOn++;
          // We assume stake implies voting TRUE
          const votedTrue = true;
          if (votedTrue === Boolean(claim.resolvedVerdict)) claimsCorrect++;
        }

        if (claimsVotedOn === 0) continue;

        const accuracy = claimsCorrect / claimsVotedOn;
        const newReputation = Math.round(accuracy * 100);

        if (user.reputation !== newReputation) {
          user.reputation = newReputation;
          await this.userRepo.save(user);
          this.logger.log(`Updated reputation for user ${user.id}: ${newReputation}`);
        }
      } catch (err) {
        this.logger.error(`Error computing reputation for user ${user.id}: ${err?.message || err}`);
      }
    }

    this.logger.debug('computeReputation: finished');
  }

  /**
   * Scheduled job for audit log retention
   * Runs according to the cron schedule defined in AUDIT_RETENTION_CRON (default: daily at 2 AM UTC)
   * Automatically purges audit logs older than the retention period
   */
  @Cron('0 0 2 * * *') // Default: Daily at 2 AM UTC
  async runAuditRetentionJob() {
    const enabled = this.configService.get<boolean>(
      'auditRetention.enabled',
      true,
    );

    if (!enabled) {
      this.logger.debug('Audit retention job is disabled');
      return;
    }

    try {
      this.logger.log('Starting scheduled audit log retention job');
      const result = await this.auditRetentionService.executeRetention();

      if (result.success) {
        this.logger.log(
          `Audit retention job completed successfully: ${result.totalDeleted} logs deleted in ${result.batchesProcessed} batches (${result.executionTimeMs}ms)`,
        );
      } else {
        this.logger.error(
          `Audit retention job failed: ${result.error}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Error running audit retention job: ${err?.message || err}`,
        err?.stack,
      );
    }
  }
}

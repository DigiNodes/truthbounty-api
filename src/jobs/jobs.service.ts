import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Stake } from '../staking/entities/stake.entity';
import { Wallet } from '../entities/wallet.entity';
import { Claim } from '../claims/entities/claim.entity';
import { User } from '../entities/user.entity';
import { AggregationService } from '../aggregation/aggregation.service';
import { ClaimsCache } from '../cache/claims.cache';

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
        this.logger.log(`Updated claim ${claim.id} confidence=${updateFields.confidenceScore}`);
      } catch (err) {
        this.logger.error(`Error processing claim ${claim.id}: ${err?.message || err}`);
      }
    }

    this.logger.debug('computeScores: finished');
  }

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
}

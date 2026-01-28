import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { RewardClaimRepository } from '../repositories/reward-claim.repository';
import { RewardDistributionRepository } from '../repositories/reward-distribution.repository';
import { RewardClaimEventDto } from '../dto/reward-claim-event.dto';
import { RewardDistributionEventDto } from '../dto/reward-distribution-event.dto';
import { RewardClaim } from '../entities/reward-claim.entity';
import { RewardDistribution } from '../entities/reward-distribution.entity';

@Injectable()
export class RewardSyncService {
  private readonly logger = new Logger(RewardSyncService.name);

  constructor(
    private readonly rewardClaimRepo: RewardClaimRepository,
    private readonly rewardDistributionRepo: RewardDistributionRepository,
  ) {}

  /**
   * Process a reward claim event - idempotent
   */
  async processRewardClaim(
    eventDto: RewardClaimEventDto,
  ): Promise<RewardClaim> {
    const { txHash, logIndex } = eventDto;

    // Check for duplicate
    const existing = await this.rewardClaimRepo.findByTxHashAndLogIndex(
      txHash,
      logIndex,
    );
    if (existing) {
      this.logger.warn(
        `Duplicate reward claim detected: ${txHash}:${logIndex}`,
      );
      return existing;
    }

    try {
      const claim = await this.rewardClaimRepo.create({
        walletAddress: eventDto.walletAddress.toLowerCase(),
        amount: eventDto.amount,
        claimId: eventDto.claimId,
        txHash: eventDto.txHash,
        blockNumber: eventDto.blockNumber,
        logIndex: eventDto.logIndex,
        blockTimestamp: new Date(eventDto.blockTimestamp * 1000),
        eventName: eventDto.eventName || 'RewardClaimed',
        metadata: eventDto.metadata,
        isProcessed: true,
      });

      this.logger.log(
        `Reward claim synced: ${eventDto.walletAddress} claimed ${eventDto.amount} (tx: ${txHash})`,
      );

      return claim;
    } catch (error) {
      if (error.code === '23505') {
        // PostgreSQL unique constraint violation
        throw new ConflictException('Duplicate reward claim event');
      }
      throw error;
    }
  }

  /**
   * Process a reward distribution event - idempotent
   */
  async processRewardDistribution(
    eventDto: RewardDistributionEventDto,
  ): Promise<RewardDistribution> {
    const { txHash, logIndex } = eventDto;

    // Check for duplicate
    const existing = await this.rewardDistributionRepo.findByTxHashAndLogIndex(
      txHash,
      logIndex,
    );
    if (existing) {
      this.logger.warn(
        `Duplicate reward distribution detected: ${txHash}:${logIndex}`,
      );
      return existing;
    }

    try {
      const distribution = await this.rewardDistributionRepo.create({
        recipients: eventDto.recipients.map((addr) => addr.toLowerCase()),
        amounts: eventDto.amounts,
        distributionId: eventDto.distributionId,
        txHash: eventDto.txHash,
        blockNumber: eventDto.blockNumber,
        logIndex: eventDto.logIndex,
        blockTimestamp: new Date(eventDto.blockTimestamp * 1000),
        eventName: eventDto.eventName || 'RewardDistributed',
        metadata: eventDto.metadata,
        isProcessed: true,
      });

      this.logger.log(
        `Reward distribution synced: ${eventDto.recipients.length} recipients (tx: ${txHash})`,
      );

      return distribution;
    } catch (error) {
      if (error.code === '23505') {
        throw new ConflictException('Duplicate reward distribution event');
      }
      throw error;
    }
  }

  /**
   * Get total rewards claimed by a wallet
   */
  async getTotalClaimedByWallet(walletAddress: string): Promise<string> {
    return this.rewardClaimRepo.getTotalClaimedByWallet(
      walletAddress.toLowerCase(),
    );
  }

  /**
   * Get claim history for a wallet
   */
  async getClaimHistory(walletAddress: string): Promise<RewardClaim[]> {
    return this.rewardClaimRepo.findByWalletAddress(
      walletAddress.toLowerCase(),
    );
  }

  /**
   * Get the last synced block number
   */
  async getLastSyncedBlock(): Promise<number> {
    const claimBlock = await this.rewardClaimRepo.getLastSyncedBlock();
    const distributionBlock =
      await this.rewardDistributionRepo.getLastSyncedBlock();
    return Math.max(claimBlock, distributionBlock);
  }
}

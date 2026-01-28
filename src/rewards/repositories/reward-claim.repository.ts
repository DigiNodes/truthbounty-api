/* eslint-disable @typescript-eslint/no-unsafe-call */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RewardClaim } from '../entities/reward-claim.entity';

@Injectable()
export class RewardClaimRepository {
  constructor(
    @InjectRepository(RewardClaim)
    private readonly repository: Repository<RewardClaim>,
  ) {}

  async findByTxHashAndLogIndex(
    txHash: string,
    logIndex: number,
  ): Promise<RewardClaim | null> {
    return this.repository.findOne({
      where: { txHash, logIndex },
    });
  }

  async findByWalletAddress(walletAddress: string): Promise<RewardClaim[]> {
    return this.repository.find({
      where: { walletAddress },
      order: { blockNumber: 'DESC' },
    });
  }

  async findByClaimId(claimId: string): Promise<RewardClaim[]> {
    return this.repository.find({
      where: { claimId },
      order: { blockNumber: 'DESC' },
    });
  }

  async create(data: Partial<RewardClaim>): Promise<RewardClaim> {
    const claim = this.repository.create(data);
    return this.repository.save(claim);
  }

  async getLastSyncedBlock(): Promise<number> {
    const result = await this.repository
      .createQueryBuilder('claim')
      .select('MAX(claim.blockNumber)', 'maxBlock')
      .getRawOne();

    return result?.maxBlock || 0;
  }

  async getTotalClaimedByWallet(walletAddress: string): Promise<string> {
    const result = await this.repository
      .createQueryBuilder('claim')
      .select('SUM(CAST(claim.amount AS DECIMAL))', 'total')
      .where('claim.walletAddress = :walletAddress', { walletAddress })
      .getRawOne();

    return result?.total || '0';
  }
}

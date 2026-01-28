import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RewardDistribution } from '../entities/reward-distribution.entity';

@Injectable()
export class RewardDistributionRepository {
  constructor(
    @InjectRepository(RewardDistribution)
    private readonly repository: Repository<RewardDistribution>,
  ) {}

  async findByTxHashAndLogIndex(
    txHash: string,
    logIndex: number,
  ): Promise<RewardDistribution | null> {
    return this.repository.findOne({
      where: { txHash, logIndex },
    });
  }

  async create(data: Partial<RewardDistribution>): Promise<RewardDistribution> {
    const distribution = this.repository.create(data);
    return this.repository.save(distribution);
  }

  async getLastSyncedBlock(): Promise<number> {
    const result = await this.repository
      .createQueryBuilder('distribution')
      .select('MAX(distribution.blockNumber)', 'maxBlock')
      .getRawOne();

    return result?.maxBlock || 0;
  }
}

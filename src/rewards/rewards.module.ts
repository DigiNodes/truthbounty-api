import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { RewardClaim } from './entities/reward-claim.entity';
import { RewardDistribution } from './entities/reward-distribution.entity';
import { RewardClaimRepository } from './repositories/reward-claim.repository';
import { RewardDistributionRepository } from './repositories/reward-distribution.repository';
import { RewardSyncService } from './services/reward-sync.service';
import { BlockchainListenerService } from './services/blockchain-listener.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([RewardClaim, RewardDistribution]),
    ConfigModule,
  ],
  providers: [
    RewardClaimRepository,
    RewardDistributionRepository,
    RewardSyncService,
    BlockchainListenerService,
  ],
  exports: [RewardSyncService],
})
export class RewardsModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { V2EventsModule } from '../events/v2-events.module';
import { ProjectRewardAllocation } from './entities/project-reward-allocation.entity';
import { ProjectRewardPool } from './entities/project-reward-pool.entity';
import { ProjectRewardClaim } from './entities/project-reward-claim.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import { IndexingAnomaly } from '../common/entities/indexing-anomaly.entity';
import { ProjectVerificationRound } from '../verification/entities/project-verification-round.entity';
import { ProjectDispute } from '../disputes/entities/project-dispute.entity';
import { EventCheckpoint } from '../events/entities/event-checkpoint.entity';
import { RewardsProjectorService } from './rewards-projector.service';
import { RewardsReconciliationService } from './rewards-reconciliation.service';
import { SettlementProjectionService } from './settlement-projection.service';
import { SettlementProjectionController } from './settlement-projection.controller';
import { BlockchainModule } from '../../blockchain/blockchain.module';
import { FinalityPolicyModule } from '../../config/finality-policy.module';

/**
 * V2-BE-017 & PREWAVE-BE-064 — reward allocation, claim projection, and exact settlement read models.
 *
 * Exposes read-only settlement projections (funded, accrued, claimed, pending,
 * claimable, slashed, refunded, dust) backed by exact integer arithmetic and
 * custody conservation reconciliation.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProjectRewardAllocation,
      ProjectRewardPool,
      ProjectRewardClaim,
      ProjectorCursor,
      IndexingAnomaly,
      ProjectVerificationRound,
      ProjectDispute,
      EventCheckpoint,
    ]),
    V2EventsModule,
    BlockchainModule,
    FinalityPolicyModule,
  ],
  controllers: [SettlementProjectionController],
  providers: [
    RewardsProjectorService,
    RewardsReconciliationService,
    SettlementProjectionService,
  ],
  exports: [
    RewardsProjectorService,
    RewardsReconciliationService,
    SettlementProjectionService,
  ],
})
export class V2RewardsModule {}

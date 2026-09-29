import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { V2EventsModule } from '../events/v2-events.module';
import { ProjectRewardAllocation } from './entities/project-reward-allocation.entity';
import { ProjectRewardPool } from './entities/project-reward-pool.entity';
import { ProjectRewardClaim } from './entities/project-reward-claim.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import { IndexingAnomaly } from '../common/entities/indexing-anomaly.entity';
import { RewardsProjectorService } from './rewards-projector.service';
import { RewardsReconciliationService } from './rewards-reconciliation.service';

/**
 * V2-BE-017 — reward allocation and claim projection.
 *
 * No controller is registered on purpose. This module is a projection plus a
 * reconciliation read model, and exposing an endpoint that *creates* or
 * *adjusts* an allocation would be precisely the backend-authored protocol
 * truth this repository must never produce. A future read-only controller is a
 * separate, additive change.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProjectRewardAllocation,
      ProjectRewardPool,
      ProjectRewardClaim,
      ProjectorCursor,
      IndexingAnomaly,
    ]),
    V2EventsModule,
  ],
  providers: [RewardsProjectorService, RewardsReconciliationService],
  exports: [RewardsProjectorService, RewardsReconciliationService],
})
export class V2RewardsModule {}

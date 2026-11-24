import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { V2EventsModule } from '../events/v2-events.module';
import { V2EvidenceModule } from '../evidence/v2-evidence.module';
import { V2VerificationModule } from '../verification/v2-verification.module';
import { V2DisputesModule } from '../disputes/v2-disputes.module';
import { V2RewardsModule } from '../rewards/v2-rewards.module';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import { IndexingAnomaly } from '../common/entities/indexing-anomaly.entity';
import { ProjectionRebuildRun } from './entities/projection-rebuild-run.entity';
import { ProjectionRebuildService } from './projection-rebuild.service';
import {
  PROJECTION_REGISTRY,
  RebuildableProjection,
  buildDefaultRegistry,
} from './projection-registry';
import { EvidenceProjectorService } from '../evidence/evidence-projector.service';
import { VerificationProjectorService } from '../verification/verification-projector.service';
import { DisputesProjectorService } from '../disputes/disputes-projector.service';
import { RewardsProjectorService } from '../rewards/rewards-projector.service';

/**
 * V2-BE-019 — deterministic full projection rebuild.
 *
 * The registry is composed here rather than contributed by each projector
 * module, deliberately: the rebuild's determinism rests on the registry being
 * a **fixed, reviewable list in a fixed order**, and a distributed
 * `forFeature`-style registration makes the effective order an accident of
 * module wiring. One file, one order, one place to review.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProjectionRebuildRun,
      CanonicalEvent,
      ProjectorCursor,
      IndexingAnomaly,
    ]),
    V2EventsModule,
    V2EvidenceModule,
    V2VerificationModule,
    V2DisputesModule,
    V2RewardsModule,
  ],
  providers: [
    ProjectionRebuildService,
    {
      provide: PROJECTION_REGISTRY,
      inject: [
        DataSource,
        EvidenceProjectorService,
        VerificationProjectorService,
        DisputesProjectorService,
        RewardsProjectorService,
      ],
      useFactory: (
        dataSource: DataSource,
        evidence: EvidenceProjectorService,
        verification: VerificationProjectorService,
        disputes: DisputesProjectorService,
        rewards: RewardsProjectorService,
      ): RebuildableProjection[] =>
        buildDefaultRegistry(dataSource, {
          evidence,
          verification,
          disputes,
          rewards,
        }),
    },
  ],
  exports: [ProjectionRebuildService, PROJECTION_REGISTRY],
})
export class V2RebuildModule {}

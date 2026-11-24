import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectDispute } from '../entities/project-dispute.entity';
import { EventCheckpoint } from '../../events/entities/event-checkpoint.entity';
import { ProjectVerificationRound } from '../../verification/entities/project-verification-round.entity';
import { DisputeReadModelController } from './dispute-read-model.controller';
import { DisputeReadModelService } from './dispute-read-model.service';
import { DisputeReadModelProvenanceService } from './dispute-read-model-provenance.service';
import { DisputeReadModelFreshnessService } from './dispute-read-model-freshness.service';

/**
 * PREWAVE-BE-007 — versioned dispute register/detail read models.
 *
 * Read-only: registers existing projection repositories and publishes the
 * versioned read models. It introduces no new TypeORM entities and no
 * migrations. The live indexer snapshot is consumed optionally by the
 * freshness service, so the module never hard-depends on the indexer module.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProjectDispute,
      EventCheckpoint,
      ProjectVerificationRound,
    ]),
  ],
  controllers: [DisputeReadModelController],
  providers: [
    DisputeReadModelService,
    DisputeReadModelProvenanceService,
    DisputeReadModelFreshnessService,
  ],
  exports: [DisputeReadModelService],
})
export class DisputeReadModelsModule {}

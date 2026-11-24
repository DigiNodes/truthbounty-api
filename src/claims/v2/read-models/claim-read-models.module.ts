import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClaimReadModel } from '../../entities/claim-read-model.entity';
import { EventCheckpoint } from '../../../v2/events/entities/event-checkpoint.entity';
import { ProjectEvidence } from '../../../v2/evidence/entities/project-evidence.entity';
import { ProjectVerificationRound } from '../../../v2/verification/entities/project-verification-round.entity';
import { ClaimReadModelController } from './claim-read-model.controller';
import { ClaimReadModelService } from './claim-read-model.service';
import { ClaimReadModelProvenanceService } from './claim-read-model-provenance.service';
import { ClaimReadModelFreshnessService } from './claim-read-model-freshness.service';

/**
 * PREWAVE-BE-005 — versioned claim list/detail read models.
 *
 * Read-only: registers existing projection repositories and publishes the
 * versioned read models. It introduces no new TypeORM entities and no
 * migrations. The live indexer snapshot is consumed optionally by the
 * freshness service, so the module never hard-depends on the indexer module.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ClaimReadModel,
      EventCheckpoint,
      ProjectEvidence,
      ProjectVerificationRound,
    ]),
  ],
  controllers: [ClaimReadModelController],
  providers: [
    ClaimReadModelService,
    ClaimReadModelProvenanceService,
    ClaimReadModelFreshnessService,
  ],
  exports: [ClaimReadModelService],
})
export class ClaimReadModelsModule {}

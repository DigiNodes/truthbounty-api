import { Module } from '@nestjs/common';
import { IpfsModule } from '../../ipfs/ipfs.module';
import { ClaimReadModelsModule } from '../v2/read-models/claim-read-models.module';
import { EvidenceUploadController } from './evidence-upload.controller';
import {
  CANONICAL_CLAIM_IDENTITY,
  EvidenceUploadPreparationService,
} from './evidence-upload-preparation.service';
import { ProjectionClaimIdentityValidator } from './projection-claim-identity.validator';

/**
 * PREWAVE-BE-132 — permitted non-authoritative upload/preparation surface.
 * No TypeORM entity, repository or migration is introduced here.
 */
@Module({
  imports: [IpfsModule, ClaimReadModelsModule],
  controllers: [EvidenceUploadController],
  providers: [
    EvidenceUploadPreparationService,
    {
      provide: CANONICAL_CLAIM_IDENTITY,
      useClass: ProjectionClaimIdentityValidator,
    },
  ],
  exports: [EvidenceUploadPreparationService],
})
export class EvidenceUploadModule {}

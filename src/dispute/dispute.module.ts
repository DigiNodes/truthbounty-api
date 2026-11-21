import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DisputeController } from './dispute.controller';
import { DisputeService } from './dispute.service';
import { DisputeEvidenceService } from './canonical-dispute-evidence.service';
import { Dispute } from './entities/dispute.entity';
import { AuthModule } from '../auth/auth.module';
import { ArtifactRegistryService } from '../v2/events/artifact-registry.service';
import { CanonicalEvent } from '../v2/events/entities/canonical-event.entity';
import { ContractArtifact } from '../v2/events/entities/contract-artifact.entity';
import { EventCheckpoint } from '../v2/events/entities/event-checkpoint.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Dispute,
      CanonicalEvent,
      ContractArtifact,
      EventCheckpoint,
    ]),
    AuthModule,
  ],
  controllers: [DisputeController],
  providers: [DisputeService, DisputeEvidenceService, ArtifactRegistryService],
  exports: [DisputeService, DisputeEvidenceService],
})
export class DisputeModule {}

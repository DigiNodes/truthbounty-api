import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GovernanceController } from './governance.controller';
import { GovernanceService } from './governance.service';
import { GovernanceCache } from './governance.cache';
import { GovernanceEvidenceService } from './canonical-governance-evidence.service';
import { Proposal, Vote } from './entities/proposal.entity';
import { CacheModule } from '../cache/cache.module';
import { AuthModule } from '../auth/auth.module';
import { CanonicalEvent } from '../v2/events/entities/canonical-event.entity';
import { ContractArtifact } from '../v2/events/entities/contract-artifact.entity';
import { EventCheckpoint } from '../v2/events/entities/event-checkpoint.entity';
import { ArtifactRegistryService } from '../v2/events/artifact-registry.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Proposal,
      Vote,
      CanonicalEvent,
      ContractArtifact,
      EventCheckpoint,
    ]),
    CacheModule,
    AuthModule,
  ],
  controllers: [GovernanceController],
  providers: [
    GovernanceService,
    GovernanceCache,
    GovernanceEvidenceService,
    ArtifactRegistryService,
  ],
  exports: [GovernanceService, GovernanceEvidenceService],
})
export class GovernanceModule {}

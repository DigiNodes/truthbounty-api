import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SybilResistanceService } from './sybil-resistance.service';
import { SybilResistanceController } from './sybil-resistance.controller';
import { SybilResistantVotingService } from './sybil-resistant-voting.service';
import { SybilModelRegistry } from './sybil-model-registry';
import { SybilProvenanceService } from './sybil-provenance.service';
import { SybilStakingAuthorityService } from './sybil-staking-authority.service';
import { PrismaModule } from '../prisma/prisma.module';
import { StakeEvent } from '../staking/entities/stake-event.entity';
import { ContractArtifact } from '../v2/events/entities/contract-artifact.entity';
import { EventCheckpoint } from '../v2/events/entities/event-checkpoint.entity';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    TypeOrmModule.forFeature([StakeEvent, ContractArtifact, EventCheckpoint]),
  ],
  controllers: [SybilResistanceController],
  providers: [
    SybilResistanceService,
    SybilResistantVotingService,
    SybilModelRegistry,
    SybilProvenanceService,
    SybilStakingAuthorityService,
  ],
  exports: [
    SybilResistanceService,
    SybilResistantVotingService,
    SybilModelRegistry,
    SybilProvenanceService,
    SybilStakingAuthorityService,
  ],
})
export class SybilResistanceModule {}

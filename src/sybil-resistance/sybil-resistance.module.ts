import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SybilResistanceService } from './sybil-resistance.service';
import { SybilResistanceController } from './sybil-resistance.controller';
import { SybilResistantVotingService } from './sybil-resistant-voting.service';
import { SybilModelRegistry } from './sybil-model-registry';
import { SybilProvenanceService } from './sybil-provenance.service';
import { PrismaModule } from '../prisma/prisma.module';
import { StakeEvent } from '../staking/entities/stake-event.entity';
import { CanonicalEvent } from '../v2/events/entities/canonical-event.entity';
import { EventCheckpoint } from '../v2/events/entities/event-checkpoint.entity';
import { ClaimAccuracyService } from './claim-accuracy.service';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    TypeOrmModule.forFeature([StakeEvent, CanonicalEvent, EventCheckpoint]),
  ],
  controllers: [SybilResistanceController],
  providers: [
    SybilResistanceService,
    SybilResistantVotingService,
    SybilModelRegistry,
    SybilProvenanceService,
    ClaimAccuracyService,
  ],
  exports: [
    SybilResistanceService,
    SybilResistantVotingService,
    SybilModelRegistry,
    SybilProvenanceService,
    ClaimAccuracyService,
  ],
})
export class SybilResistanceModule {}

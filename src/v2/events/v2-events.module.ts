import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CanonicalEvent } from './entities/canonical-event.entity';
import { ContractArtifact } from './entities/contract-artifact.entity';
import { EventQuarantine } from './entities/event-quarantine.entity';
import { EventCheckpoint } from './entities/event-checkpoint.entity';
import { ArtifactRegistryService } from './artifact-registry.service';
import { EventDecoderService } from './event-decoder.service';
import { CanonicalEventsService } from './canonical-events.service';
import { CanonicalEventQueryService } from './canonical-event-query.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CanonicalEvent,
      ContractArtifact,
      EventQuarantine,
      EventCheckpoint,
    ]),
  ],
  providers: [
    ArtifactRegistryService,
    EventDecoderService,
    CanonicalEventsService,
    CanonicalEventQueryService,
  ],
  exports: [
    CanonicalEventsService,
    CanonicalEventQueryService,
    ArtifactRegistryService,
    TypeOrmModule,
  ],
})
export class V2EventsModule {}

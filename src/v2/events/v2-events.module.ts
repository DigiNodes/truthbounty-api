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
import { IndexerConfigService } from '../../config/indexer-config.service';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';

import { ReorgRollbackService } from './reorg-rollback.service';
import { ReorgRecoveryService } from './reorg-recovery.service';
import { ReorgJournalEntry } from './entities/reorg-journal.entity';
import { EventQuarantineService } from './event-quarantine.service';
import { EventQuarantineReplayService } from './event-quarantine-replay.service';
import { EventQuarantineRetentionService } from './event-quarantine-retention.service';
import { EventQuarantineController } from './event-quarantine.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CanonicalEvent,
      ContractArtifact,
      EventQuarantine,
      EventCheckpoint,
      ReorgJournalEntry,
      ProjectorCursor,
    ]),
  ],
  controllers: [EventQuarantineController],
  providers: [
    ArtifactRegistryService,
    EventDecoderService,
    CanonicalEventsService,
    CanonicalEventQueryService,
    ReorgRollbackService,
    ReorgRecoveryService,
    IndexerConfigService,
    EventQuarantineService,
    EventQuarantineReplayService,
    EventQuarantineRetentionService,
  ],
  exports: [
    CanonicalEventsService,
    CanonicalEventQueryService,
    ArtifactRegistryService,
    ReorgRollbackService,
    ReorgRecoveryService,
    EventQuarantineService,
    EventQuarantineReplayService,
    TypeOrmModule,
  ],
})
export class V2EventsModule {}

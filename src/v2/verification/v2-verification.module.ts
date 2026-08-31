import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { V2EventsModule } from '../events/v2-events.module';
import { EventCheckpoint } from '../events/entities/event-checkpoint.entity';
import { ProjectVerificationRound } from './entities/project-verification-round.entity';
import { ProjectParticipantPosition } from './entities/project-participant-position.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import { IndexingAnomaly } from '../common/entities/indexing-anomaly.entity';
import { VerificationProjectorService } from './verification-projector.service';
import { VerificationQueryService } from './verification-query.service';
import { VerificationController } from './verification.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProjectVerificationRound,
      ProjectParticipantPosition,
      ProjectorCursor,
      IndexingAnomaly,
      EventCheckpoint,
    ]),
    V2EventsModule,
  ],
  controllers: [VerificationController],
  providers: [VerificationProjectorService, VerificationQueryService],
  exports: [VerificationProjectorService, VerificationQueryService],
})
export class V2VerificationModule {}
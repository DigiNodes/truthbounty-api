import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { V2EventsModule } from '../events/v2-events.module';
import { EventCheckpoint } from '../events/entities/event-checkpoint.entity';
import { ProjectDispute } from './entities/project-dispute.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import { IndexingAnomaly } from '../common/entities/indexing-anomaly.entity';
import { DisputesProjectorService } from './disputes-projector.service';
import { DisputesQueryService } from './disputes-query.service';
import { DisputesController } from './disputes.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProjectDispute,
      ProjectorCursor,
      IndexingAnomaly,
      EventCheckpoint,
    ]),
    V2EventsModule,
  ],
  controllers: [DisputesController],
  providers: [DisputesProjectorService, DisputesQueryService],
  exports: [DisputesProjectorService, DisputesQueryService],
})
export class V2DisputesModule {}
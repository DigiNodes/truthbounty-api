import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { V2EventsModule } from '../events/v2-events.module';
import { ProjectEvidence } from './entities/project-evidence.entity';
import { ProjectEvidenceVersion } from './entities/project-evidence-version.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import { EvidenceProjectorService } from './evidence-projector.service';
import { EvidenceQueryService } from './evidence-query.service';
import { EvidenceController } from './evidence.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProjectEvidence,
      ProjectEvidenceVersion,
      ProjectorCursor,
    ]),
    V2EventsModule,
  ],
  controllers: [EvidenceController],
  providers: [EvidenceProjectorService, EvidenceQueryService],
  exports: [EvidenceProjectorService, EvidenceQueryService],
})
export class V2EvidenceModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { V2EventsModule } from '../events/v2-events.module';
import { ProjectEvidence } from './entities/project-evidence.entity';
import { ProjectEvidenceVersion } from './entities/project-evidence-version.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import { ProjectionReadinessModule } from '../common/projection-readiness/projection-readiness.module';
import { EvidenceProjectorService } from './evidence-projector.service';
import { EvidenceQueryService } from './evidence-query.service';
import { EvidenceIntegrityService } from './evidence-integrity.service';
import { EvidenceController, EvidenceIntegrityController } from './evidence.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProjectEvidence,
      ProjectEvidenceVersion,
      ProjectorCursor,
    ]),
    V2EventsModule,
    ProjectionReadinessModule,
  ],
  controllers: [EvidenceController, EvidenceIntegrityController],
  providers: [
    EvidenceProjectorService,
    EvidenceQueryService,
    EvidenceIntegrityService,
  ],
  exports: [
    EvidenceProjectorService,
    EvidenceQueryService,
    EvidenceIntegrityService,
  ],
})
export class V2EvidenceModule {}

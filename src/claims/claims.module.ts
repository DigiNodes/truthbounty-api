import { MiddlewareConsumer, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Claim } from './entities/claim.entity';
import { Evidence } from './entities/evidence.entity';
import { EvidenceVersion } from './entities/evidence-version.entity';
import { EvidenceFlag } from './entities/evidence-flag.entity';
import { Stake } from '../staking/entities/stake.entity';
import { ClaimsService } from './claims.service';
import { ClaimsController } from './claims.controller';
import { ClaimResolutionService } from './claim-resolution.service';
import { EvidenceService } from './evidence.service';
import { CacheModule } from '../cache/cache.module';
import { EvidenceIntegrityMiddleware } from '../common/middleware/evidence-integrity.middleware';
import { EvidenceFlagService } from './evidence-flag.service';
import { EvidenceController } from './evidence.controller';
import { ClaimLifecycleEvent } from './entities/claim-lifecycle-event.entity';
import { ClaimReadModel } from './entities/claim-read-model.entity';
import { ClaimProjectorService } from './claim-projector.service';
import { ClaimLifecycleController } from './claim-lifecycle.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Claim,
      Evidence,
      EvidenceVersion,
      EvidenceFlag,
      Stake,
      ClaimLifecycleEvent,
      ClaimReadModel,
    ]),
    CacheModule,
  ],
  controllers: [ClaimsController, EvidenceController, ClaimLifecycleController],
  providers: [
    ClaimsService,
    ClaimResolutionService,
    EvidenceService,
    EvidenceFlagService,
    ClaimProjectorService,
  ],
  exports: [
    ClaimResolutionService,
    ClaimsService,
    EvidenceService,
    ClaimProjectorService,
  ],
})
export class ClaimsModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(EvidenceIntegrityMiddleware)
      .forRoutes('claims/upload-evidence');
  }
}

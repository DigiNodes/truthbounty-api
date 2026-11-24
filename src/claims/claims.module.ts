import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Claim } from './entities/claim.entity';
import { Evidence } from './entities/evidence.entity';
import { EvidenceVersion } from './entities/evidence-version.entity';
import { EvidenceFlag } from './entities/evidence-flag.entity';
import { Stake } from '../staking/entities/stake.entity';
import { ClaimsService } from './claims.service';
import { ClaimsController } from './claims.controller';
import { EvidenceService } from './evidence.service';
import { ClaimResolutionService } from './claim-resolution.service';
import { CacheModule } from '../cache/cache.module';
import { EvidenceIntegrityMiddleware } from '../common/middleware/evidence-integrity.middleware';
import { EvidenceFlagService } from './evidence-flag.service';
import { EvidenceController } from './evidence.controller';
import { ClaimLifecycleEvent } from './entities/claim-lifecycle-event.entity';
import { ClaimReadModel } from './entities/claim-read-model.entity';
import { ClaimProjectorService } from './claim-projector.service';
import { ClaimLifecycleController } from './claim-lifecycle.controller';
import { IpfsModule } from '../ipfs/ipfs.module';
import { ClaimLifecycleErrorFilter } from './claim-lifecycle.errors';
import { SecretQuarantine } from './entities/secret-quarantine.entity';
import { SecretQuarantineAccessLog } from './entities/secret-quarantine-access-log.entity';
import { SecretScannerService } from './secret-scanner.service';
import { SecretQuarantineService } from './secret-quarantine.service';
import { SecretQuarantineController } from './secret-quarantine.controller';
import { SecretScanningMiddleware } from '../common/middleware/secret-scanning.middleware';

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
      SecretQuarantine,
      SecretQuarantineAccessLog,
    ]),
    CacheModule,
    IpfsModule,
  ],
  controllers: [
    ClaimsController,
    EvidenceController,
    ClaimLifecycleController,
    SecretQuarantineController,
  ],
  providers: [
    ClaimsService,
    EvidenceService,
    EvidenceFlagService,
    ClaimProjectorService,
    ClaimResolutionService,
    ClaimLifecycleErrorFilter,
    SecretScannerService,
    SecretQuarantineService,
  ],
  exports: [
    ClaimResolutionService,
    ClaimsService,
    EvidenceService,
    ClaimProjectorService,
    SecretScannerService,
    SecretQuarantineService,
  ],
})
export class ClaimsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(EvidenceIntegrityMiddleware)
      .forRoutes('claims/upload-evidence');
    consumer
      .apply(SecretScanningMiddleware)
      .forRoutes('claims/support', 'claims/support/:id/messages');
  }
}
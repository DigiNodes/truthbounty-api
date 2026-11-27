import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Claim } from './entities/claim.entity';
import { Evidence } from './entities/evidence.entity';
import { EvidenceVersion } from './entities/evidence-version.entity';
import { EvidenceFlag } from './entities/evidence-flag.entity';
import { Stake } from '../staking/entities/stake.entity';
import { ClaimsController } from './claims.controller';
import { EvidenceFlagService } from './evidence-flag.service';
import { EvidenceController } from './evidence.controller';
import { ClaimReadModel } from './entities/claim-read-model.entity';
import { ClaimLifecycleController } from './claim-lifecycle.controller';
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
      ClaimReadModel,
      SecretQuarantine,
      SecretQuarantineAccessLog,
    ]),
  ],
  controllers: [
    ClaimsController,
    EvidenceController,
    SecretQuarantineController,
  ],
  providers: [
    EvidenceFlagService,
    ClaimLifecycleErrorFilter,
    SecretScannerService,
    SecretQuarantineService,
  ],
  exports: [
    SecretScannerService,
    SecretQuarantineService,
  ],
})
export class ClaimsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(SecretScanningMiddleware)
      .forRoutes('claims/support', 'claims/support/:id/messages');
  }
}
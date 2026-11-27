import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AdminModule } from '../admin/admin.module';
import { DatabaseModule } from '../database/database.module';
import { getRuntimeEnvironment } from '../config/runtime-config';
import {
  ABUSE_APPEAL_POLICY,
  ABUSE_APPEAL_REGISTER,
  AbuseAppealService,
  DEFAULT_ABUSE_APPEAL_POLICY,
} from './abuse-appeal.service';
import {
  ABUSE_CLOCK,
  ABUSE_DETECTORS,
  AbuseSignalService,
  SystemAbuseClock,
  buildAbuseDetectors,
} from './abuse-signal.service';
import { ABUSE_SIGNAL_STORE } from './abuse-signal.store';
import { AbuseSignalInterceptor } from './abuse-signal.interceptor';
import { AbuseSignalsController } from './abuse-signals.controller';
import {
  ABUSE_POLICY,
  ABUSE_RELEASE_BINDING,
  AbusePolicyConfig,
  loadAbusePolicyConfig,
  loadAbuseReleaseBinding,
} from './abuse-signals.config';
import { AbuseSignalsStartupValidator } from './abuse-signals-startup-validator';
import { AbuseAppealRecord } from './entities/abuse-appeal-record.entity';
import { AbuseDecisionRecord } from './entities/abuse-decision-record.entity';
import { AbuseActionRecord } from './entities/abuse-action-record.entity';
import { AbuseAppealDecisionHistoryRecord } from './entities/abuse-appeal-decision-history.entity';
import {
  TypeOrmAbuseAppealRegister,
  TypeOrmAbuseSignalStore,
} from './persistent-abuse.store';

/**
 * Abuse signals (PREWAVE-BE-086, #681; PREWAVE-BE-111, #812).
 *
 * Detect scraping, credential stuffing, spam submissions, webhook abuse, stream
 * storms and support flooding; keep every automated action bounded,
 * time-limited and appealable; and stop there.
 *
 * **This module is not protocol authority.** It holds no repository for claims,
 * verification, disputes, rewards, treasury or governance, injects no chain
 * client and no signer, and writes only abuse-signal evidence tables.
 * Finalized canonical contract events remain authoritative for anything
 * on-chain, and a signal can never change an outcome.
 *
 * **Default is observe-only.** `loadAbusePolicyConfig` leaves
 * `enforcementEnabled` false, so a fresh deployment records signals and refuses
 * nothing. Turning enforcement on is a deliberate maintainer action, which is
 * why this can sit on `main` as a candidate before activation. Decisions,
 * bounded actions and appeals are persisted in PostgreSQL even while the module
 * is observing, so a restart cannot erase moderation evidence.
 */
@Module({
  imports: [
    AdminModule,
    DatabaseModule,
    TypeOrmModule.forFeature([
      AbuseDecisionRecord,
      AbuseActionRecord,
      AbuseAppealRecord,
      AbuseAppealDecisionHistoryRecord,
    ]),
  ],
  controllers: [AbuseSignalsController],
  providers: [
    AbuseSignalService,
    AbuseAppealService,
    AbuseSignalInterceptor,
    AbuseSignalsStartupValidator,
    {
      provide: ABUSE_POLICY,
      useFactory: (): AbusePolicyConfig => loadAbusePolicyConfig(),
    },
    {
      provide: ABUSE_RELEASE_BINDING,
      useFactory: () => loadAbuseReleaseBinding(),
    },
    {
      provide: ABUSE_DETECTORS,
      useFactory: (policy: AbusePolicyConfig) => buildAbuseDetectors(policy),
      inject: [ABUSE_POLICY],
    },
    { provide: ABUSE_CLOCK, useClass: SystemAbuseClock },
    { provide: ABUSE_SIGNAL_STORE, useClass: TypeOrmAbuseSignalStore },
    { provide: ABUSE_APPEAL_REGISTER, useClass: TypeOrmAbuseAppealRegister },
    {
      provide: ABUSE_APPEAL_POLICY,
      useValue: DEFAULT_ABUSE_APPEAL_POLICY,
    },
  ],
  exports: [
    AbuseSignalService,
    AbuseAppealService,
    ABUSE_POLICY,
    ABUSE_SIGNAL_STORE,
  ],
})
export class AbuseSignalsModule {}

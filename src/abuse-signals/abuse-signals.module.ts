import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { DatabaseModule } from '../database/database.module';
import {
  ABUSE_APPEAL_POLICY,
  ABUSE_APPEAL_REGISTER,
  AbuseAppealService,
  DEFAULT_ABUSE_APPEAL_POLICY,
  InMemoryAbuseAppealRegister,
} from './abuse-appeal.service';
import {
  ABUSE_CLOCK,
  ABUSE_DETECTORS,
  AbuseSignalService,
  SystemAbuseClock,
  buildAbuseDetectors,
} from './abuse-signal.service';
import {
  ABUSE_SIGNAL_STORE,
  InMemoryAbuseSignalStore,
} from './abuse-signal.store';
import { AbuseSignalInterceptor } from './abuse-signal.interceptor';
import { AbuseSignalsController } from './abuse-signals.controller';
import {
  ABUSE_POLICY,
  ABUSE_RELEASE_BINDING,
  AbusePolicyConfig,
  loadAbusePolicyConfig,
  loadAbuseReleaseBinding,
} from './abuse-signals.config';
import { AbuseAppealRecord } from './entities/abuse-appeal-record.entity';
import { AbuseDecisionRecord } from './entities/abuse-decision-record.entity';

/**
 * Abuse signals (PREWAVE-BE-086, #681).
 *
 * Detect scraping, credential stuffing, spam submissions, webhook abuse, stream
 * storms and support flooding; keep every automated action bounded,
 * time-limited and appealable; and stop there.
 *
 * **This module is not protocol authority.** It holds no repository for claims,
 * verification, disputes, rewards, treasury or governance, injects no chain
 * client and no signer, and writes only `abuse_decisions` / `abuse_appeals`.
 * Finalized canonical contract events remain authoritative for anything
 * on-chain, and a signal can never change an outcome.
 *
 * **Default is observe-only.** `loadAbusePolicyConfig` leaves
 * `enforcementEnabled` false, so a fresh deployment records signals and refuses
 * nothing. Turning enforcement on is a deliberate maintainer action, which is
 * why this can sit on `main` as a candidate before activation.
 *
 * **No new external dependency while observing.** The default store and appeal
 * register are in-process and bounded. Deployments that enable enforcement
 * across more than one replica bind shared implementations to
 * {@link ABUSE_SIGNAL_STORE} and {@link ABUSE_APPEAL_REGISTER}; the interfaces
 * above them do not change.
 */
@Module({
  imports: [
    AdminModule,
    DatabaseModule,
    TypeOrmModule.forFeature([AbuseDecisionRecord, AbuseAppealRecord]),
  ],
  controllers: [AbuseSignalsController],
  providers: [
    AbuseSignalService,
    AbuseAppealService,
    AbuseSignalInterceptor,
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
    {
      provide: ABUSE_SIGNAL_STORE,
      useFactory: (): InMemoryAbuseSignalStore => new InMemoryAbuseSignalStore(),
    },
    { provide: ABUSE_APPEAL_REGISTER, useClass: InMemoryAbuseAppealRegister },
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
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
  AbuseSignalStore,
  InMemoryAbuseSignalStore,
} from './abuse-signal.store';
import { PostgresAbuseSignalStore } from './postgres-abuse-signal.store';
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
import { AbuseSignalWindowRecord } from './entities/abuse-signal-window.entity';
import { AbuseActionRecord } from './entities/abuse-action.entity';

/**
 * Abuse signals (PREWAVE-BE-086, #681; PREWAVE-BE-111, #812).
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
 * **Shared store for multi-replica deployments.** The default store is
 * in-memory and bounded, suitable for observe-only mode. Deployments that
 * enable enforcement set `ABUSE_SIGNALS_SHARED_STORE=postgres` to bind a shared
 * PostgreSQL-backed implementation. The startup validator aborts if enforcement
 * is enabled with the in-memory store (fail closed).
 *
 * **Configuration:**
 *  - `ABUSE_SIGNALS_SHARED_STORE=postgres` — use PostgreSQL-backed store
 *  - `ABUSE_SIGNALS_SHARED_STORE=memory` or unset — use in-memory store
 *  - `ABUSE_SIGNALS_ENFORCEMENT_ENABLED=true` — enable enforcement (requires
 *    shared store)
 */
@Module({
  imports: [
    AdminModule,
    DatabaseModule,
    TypeOrmModule.forFeature([
      AbuseDecisionRecord,
      AbuseAppealRecord,
      AbuseSignalWindowRecord,
      AbuseActionRecord,
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
    {
      provide: ABUSE_SIGNAL_STORE,
      useFactory: (
        windowRepo: Repository<AbuseSignalWindowRecord>,
        actionRepo: Repository<AbuseActionRecord>,
        decisionRepo: Repository<AbuseDecisionRecord>,
      ): AbuseSignalStore => {
        const storeType = getRuntimeEnvironment().ABUSE_SIGNALS_SHARED_STORE;
        
        if (storeType === 'postgres') {
          return new PostgresAbuseSignalStore(
            windowRepo,
            actionRepo,
            decisionRepo,
          );
        }
        
        // Default: in-memory store (observe-only mode)
        return new InMemoryAbuseSignalStore();
      },
      inject: [
        'AbuseSignalWindowRecordRepository',
        'AbuseActionRecordRepository',
        'AbuseDecisionRecordRepository',
      ],
    },
    {
      provide: 'AbuseSignalWindowRecordRepository',
      useFactory: (dataSource: DataSource) =>
        dataSource.getRepository(AbuseSignalWindowRecord),
      inject: [DataSource],
    },
    {
      provide: 'AbuseActionRecordRepository',
      useFactory: (dataSource: DataSource) =>
        dataSource.getRepository(AbuseActionRecord),
      inject: [DataSource],
    },
    {
      provide: 'AbuseDecisionRecordRepository',
      useFactory: (dataSource: DataSource) =>
        dataSource.getRepository(AbuseDecisionRecord),
      inject: [DataSource],
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
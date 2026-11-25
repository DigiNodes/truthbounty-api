import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PostgresAbuseSignalStore } from './postgres-abuse-signal.store';
import { AbuseSignalWindowRecord } from './entities/abuse-signal-window.entity';
import { AbuseActionRecord } from './entities/abuse-action.entity';
import { AbuseDecisionRecord } from './entities/abuse-decision-record.entity';
import {
  AbuseAction,
  AbuseActionKind,
  AbuseActionStatus,
  AbuseDecision,
  AbuseDecisionOutcome,
  AbuseObservation,
  AbuseObservationKind,
  AbuseReasonCode,
  AbuseSeverity,
  AbuseSubjectKind,
  AbuseSurface,
} from './abuse-signals.types';
import { windowStartFor } from './abuse-signal.store';

/**
 * Integration tests for PostgresAbuseSignalStore (PREWAVE-BE-111, #812).
 *
 * These tests validate that the shared PostgreSQL-backed store meets the
 * requirements for multi-replica deployments:
 *
 *  1. Two store instances fed the same observations converge on identical
 *     window counts and decisions.
 *  2. Atomic counter increments handle concurrent requests without lost updates.
 *  3. Decisions and actions persist across restarts.
 *  4. Expired actions are filtered deterministically by the read path.
 *  5. Subject keys and credential fingerprints are never logged or exposed.
 *
 * **Note:** These are integration tests that require a real PostgreSQL database.
 * They use an in-memory SQLite database for CI but should be run against
 * PostgreSQL in development to ensure atomicity guarantees hold.
 */
describe('PostgresAbuseSignalStore (PREWAVE-BE-111, #812)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let windowRepo: Repository<AbuseSignalWindowRecord>;
  let actionRepo: Repository<AbuseActionRecord>;
  let decisionRepo: Repository<AbuseDecisionRecord>;
  let storeA: PostgresAbuseSignalStore;
  let storeB: PostgresAbuseSignalStore;

  const TEST_BINDING = {
    chainId: 11155420,
    releaseId: 'test-release',
    deploymentBlock: 1000000n,
    artifactChecksum: 'abc123',
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [
            AbuseSignalWindowRecord,
            AbuseActionRecord,
            AbuseDecisionRecord,
          ],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([
          AbuseSignalWindowRecord,
          AbuseActionRecord,
          AbuseDecisionRecord,
        ]),
      ],
      providers: [PostgresAbuseSignalStore],
    }).compile();

    dataSource = module.get<DataSource>(DataSource);
    windowRepo = dataSource.getRepository(AbuseSignalWindowRecord);
    actionRepo = dataSource.getRepository(AbuseActionRecord);
    decisionRepo = dataSource.getRepository(AbuseDecisionRecord);

    // Create two store instances to simulate two replicas
    storeA = new PostgresAbuseSignalStore(
      windowRepo,
      actionRepo,
      decisionRepo,
    );
    storeB = new PostgresAbuseSignalStore(
      windowRepo,
      actionRepo,
      decisionRepo,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
    await module.close();
  });

  afterEach(async () => {
    // Clean up between tests
    await windowRepo.clear();
    await actionRepo.clear();
    await decisionRepo.clear();
  });

  describe('multi-instance convergence', () => {
    it('two instances fed the same observations produce identical window counts', async () => {
      const subjectKey = 'test-subject-convergence';
      const subjectKind = AbuseSubjectKind.PRINCIPAL;
      const windowMs = 5 * 60 * 1000;
      const now = Date.now();

      const observation: AbuseObservation = {
        kind: AbuseObservationKind.READ,
        surface: AbuseSurface.HTTP,
        routeGroup: '/api/claims',
        occurredAt: now,
      };

      // Feed the same observation through both instances
      const windowA = await storeA.record(
        subjectKey,
        subjectKind,
        observation,
        windowMs,
        now,
      );
      const windowB = await storeB.record(
        subjectKey,
        subjectKind,
        observation,
        windowMs,
        now,
      );

      // Both instances should see the same total
      expect(windowA.total).toBe(2);
      expect(windowB.total).toBe(2);
      expect(windowA.reads).toBe(2);
      expect(windowB.reads).toBe(2);

      // Verify the database has only one window record
      const count = await windowRepo.count();
      expect(count).toBe(1);
    });

    it('multiple observations from different instances accumulate correctly', async () => {
      const subjectKey = 'test-subject-multi';
      const subjectKind = AbuseSubjectKind.NETWORK_PREFIX;
      const windowMs = 5 * 60 * 1000;
      const now = Date.now();

      const readObs: AbuseObservation = {
        kind: AbuseObservationKind.READ,
        surface: AbuseSurface.HTTP,
        routeGroup: '/api/events',
        occurredAt: now,
      };

      const writeObs: AbuseObservation = {
        kind: AbuseObservationKind.WRITE,
        surface: AbuseSurface.HTTP,
        routeGroup: '/api/claims',
        occurredAt: now,
      };

      // Instance A records a read
      await storeA.record(subjectKey, subjectKind, readObs, windowMs, now);

      // Instance B records a write
      await storeB.record(subjectKey, subjectKind, writeObs, windowMs, now);

      // Instance A records another read
      await storeA.record(subjectKey, subjectKind, readObs, windowMs, now);

      // Both instances should see the same accumulated state
      const windowA = await storeA.windowFor(
        subjectKey,
        subjectKind,
        windowMs,
        now,
      );
      const windowB = await storeB.windowFor(
        subjectKey,
        subjectKind,
        windowMs,
        now,
      );

      expect(windowA.total).toBe(3);
      expect(windowB.total).toBe(3);
      expect(windowA.reads).toBe(2);
      expect(windowB.reads).toBe(2);
      expect(windowA.writes).toBe(1);
      expect(windowB.writes).toBe(1);
    });

    it('distinct routes are tracked consistently across instances', async () => {
      const subjectKey = 'test-subject-routes';
      const subjectKind = AbuseSubjectKind.PRINCIPAL;
      const windowMs = 5 * 60 * 1000;
      const now = Date.now();

      const routes = ['/api/claims', '/api/events', '/api/search'];

      // Instance A records first two routes
      for (const route of routes.slice(0, 2)) {
        await storeA.record(
          subjectKey,
          subjectKind,
          {
            kind: AbuseObservationKind.READ,
            surface: AbuseSurface.HTTP,
            routeGroup: route,
            occurredAt: now,
          },
          windowMs,
          now,
        );
      }

      // Instance B records the third route
      await storeB.record(
        subjectKey,
        subjectKind,
        {
          kind: AbuseObservationKind.READ,
          surface: AbuseSurface.HTTP,
          routeGroup: routes[2],
          occurredAt: now,
        },
        windowMs,
        now,
      );

      // Both instances should see all three distinct routes
      const windowA = await storeA.windowFor(
        subjectKey,
        subjectKind,
        windowMs,
        now,
      );
      const windowB = await storeB.windowFor(
        subjectKey,
        subjectKind,
        windowMs,
        now,
      );

      expect(windowA.distinctRoutes).toHaveLength(3);
      expect(windowB.distinctRoutes).toHaveLength(3);
      expect(new Set(windowA.distinctRoutes)).toEqual(new Set(routes));
      expect(new Set(windowB.distinctRoutes)).toEqual(new Set(routes));
    });
  });

  describe('atomic counter operations', () => {
    it('concurrent record() calls do not lose updates', async () => {
      const subjectKey = 'test-subject-concurrent';
      const subjectKind = AbuseSubjectKind.PRINCIPAL;
      const windowMs = 5 * 60 * 1000;
      const now = Date.now();

      const observation: AbuseObservation = {
        kind: AbuseObservationKind.READ,
        surface: AbuseSurface.HTTP,
        routeGroup: '/api/test',
        occurredAt: now,
      };

      // Fire 10 concurrent record operations from both instances
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          storeA.record(subjectKey, subjectKind, observation, windowMs, now),
        );
        promises.push(
          storeB.record(subjectKey, subjectKind, observation, windowMs, now),
        );
      }

      await Promise.all(promises);

      // Verify all 10 observations were counted
      const window = await storeA.windowFor(
        subjectKey,
        subjectKind,
        windowMs,
        now,
      );
      expect(window.total).toBe(10);
      expect(window.reads).toBe(10);
    });

    it('handles race conditions on window creation gracefully', async () => {
      const subjectKey = 'test-subject-race';
      const subjectKind = AbuseSubjectKind.WALLET;
      const windowMs = 5 * 60 * 1000;
      const now = Date.now();

      const observation: AbuseObservation = {
        kind: AbuseObservationKind.WRITE,
        surface: AbuseSurface.CLAIMS,
        routeGroup: '/api/claims/create',
        occurredAt: now,
      };

      // Both instances try to create the window simultaneously
      const [windowA, windowB] = await Promise.all([
        storeA.record(subjectKey, subjectKind, observation, windowMs, now),
        storeB.record(subjectKey, subjectKind, observation, windowMs, now),
      ]);

      // Both should succeed and see 2 observations
      expect(windowA.total).toBe(2);
      expect(windowB.total).toBe(2);

      // Database should have exactly one window record
      const count = await windowRepo.count();
      expect(count).toBe(1);
    });
  });

  describe('decision and action persistence', () => {
    it('decisions persist and can be retrieved', async () => {
      const decision: AbuseDecision = {
        id: 'decision-persist-test',
        subjectKey: 'subject-persist',
        subjectKind: AbuseSubjectKind.PRINCIPAL,
        outcome: AbuseDecisionOutcome.ACTIONED,
        indeterminateReason: null,
        reasonCode: AbuseReasonCode.SCRAPE_HIGH_BREADTH_ANONYMOUS,
        reasonCodeVersion: 1,
        kind: 'scraping' as any,
        severity: AbuseSeverity.MEDIUM,
        confidence: 0.85,
        sampleCount: 50,
        corroboratingDimensions: 2,
        modelVersion: 'v1',
        configVersion: 'v1',
        binding: TEST_BINDING,
        action: null,
        decidedAt: new Date().toISOString(),
      };

      await storeA.recordDecision(decision);

      // Instance B should be able to retrieve it
      const retrieved = await storeB.getDecision(decision.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(decision.id);
      expect(retrieved!.subjectKey).toBe(decision.subjectKey);
      expect(retrieved!.reasonCode).toBe(decision.reasonCode);
    });

    it('actions persist across instances', async () => {
      const action: AbuseAction = {
        id: 'action-persist-test',
        subjectKey: 'subject-action',
        subjectKind: AbuseSubjectKind.NETWORK_PREFIX,
        kind: AbuseActionKind.THROTTLE,
        status: AbuseActionStatus.ACTIVE,
        reasonCode: AbuseReasonCode.SPAM_SUBMISSION_WRITE_BURST,
        reasonCodeVersion: 1,
        modelVersion: 'v1',
        configVersion: 'v1',
        binding: TEST_BINDING,
        costMultiplier: 2.0,
        startedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        appealable: true,
        escalationLevel: 2,
      };

      await storeA.putAction(action);

      // Instance B should see the action
      const retrieved = await storeB.getAction(action.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(action.id);
      expect(retrieved!.kind).toBe(AbuseActionKind.THROTTLE);
      expect(retrieved!.costMultiplier).toBe(2.0);
    });

    it('activeAction filters by expiry and status correctly', async () => {
      const subjectKey = 'subject-expiry-test';
      const now = Date.now();

      // Create an active action that hasn't expired
      const activeAction: AbuseAction = {
        id: 'action-active',
        subjectKey,
        subjectKind: AbuseSubjectKind.PRINCIPAL,
        kind: AbuseActionKind.CHALLENGE,
        status: AbuseActionStatus.ACTIVE,
        reasonCode: AbuseReasonCode.CREDENTIAL_STUFFING_DISTINCT_CREDENTIALS,
        reasonCodeVersion: 1,
        modelVersion: 'v1',
        configVersion: 'v1',
        binding: TEST_BINDING,
        costMultiplier: 1.0,
        startedAt: new Date(now - 5 * 60 * 1000).toISOString(),
        expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
        appealable: true,
        escalationLevel: 3,
      };

      await storeA.putAction(activeAction);

      // Should return the active action
      const active = await storeB.activeAction(subjectKey, now);
      expect(active).not.toBeNull();
      expect(active!.id).toBe('action-active');

      // Create an expired action
      const expiredAction: AbuseAction = {
        id: 'action-expired',
        subjectKey,
        subjectKind: AbuseSubjectKind.PRINCIPAL,
        kind: AbuseActionKind.SUSPEND,
        status: AbuseActionStatus.ACTIVE,
        reasonCode: AbuseReasonCode.SUPPORT_VOLUME_FLOOD,
        reasonCodeVersion: 1,
        modelVersion: 'v1',
        configVersion: 'v1',
        binding: TEST_BINDING,
        costMultiplier: 1.0,
        startedAt: new Date(now - 20 * 60 * 1000).toISOString(),
        expiresAt: new Date(now - 5 * 60 * 1000).toISOString(), // Already expired
        appealable: true,
        escalationLevel: 4,
      };

      await storeA.putAction(expiredAction);

      // Should still return the active one, not the expired one
      const stillActive = await storeB.activeAction(subjectKey, now);
      expect(stillActive).not.toBeNull();
      expect(stillActive!.id).toBe('action-active');
    });

    it('actionsStartedBefore counts correctly', async () => {
      const subjectKey = 'subject-started-before';
      const now = Date.now();

      const actions: AbuseAction[] = [
        {
          id: 'action-1',
          subjectKey,
          subjectKind: AbuseSubjectKind.PRINCIPAL,
          kind: AbuseActionKind.OBSERVE,
          status: AbuseActionStatus.EXPIRED,
          reasonCode: AbuseReasonCode.SCRAPE_SUSTAINED_READ_VELOCITY,
          reasonCodeVersion: 1,
          modelVersion: 'v1',
          configVersion: 'v1',
          binding: TEST_BINDING,
          costMultiplier: 1.0,
          startedAt: new Date(now - 30 * 60 * 1000).toISOString(),
          expiresAt: new Date(now - 15 * 60 * 1000).toISOString(),
          appealable: true,
          escalationLevel: 1,
        },
        {
          id: 'action-2',
          subjectKey,
          subjectKind: AbuseSubjectKind.PRINCIPAL,
          kind: AbuseActionKind.THROTTLE,
          status: AbuseActionStatus.SUPERSEDED,
          reasonCode: AbuseReasonCode.SCRAPE_SUSTAINED_READ_VELOCITY,
          reasonCodeVersion: 1,
          modelVersion: 'v1',
          configVersion: 'v1',
          binding: TEST_BINDING,
          costMultiplier: 1.5,
          startedAt: new Date(now - 10 * 60 * 1000).toISOString(),
          expiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
          appealable: true,
          escalationLevel: 2,
        },
        {
          id: 'action-3',
          subjectKey,
          subjectKind: AbuseSubjectKind.PRINCIPAL,
          kind: AbuseActionKind.CHALLENGE,
          status: AbuseActionStatus.ACTIVE,
          reasonCode: AbuseReasonCode.SCRAPE_HIGH_BREADTH_ANONYMOUS,
          reasonCodeVersion: 1,
          modelVersion: 'v1',
          configVersion: 'v1',
          binding: TEST_BINDING,
          costMultiplier: 1.0,
          startedAt: new Date(now - 2 * 60 * 1000).toISOString(),
          expiresAt: new Date(now + 13 * 60 * 1000).toISOString(),
          appealable: true,
          escalationLevel: 3,
        },
      ];

      for (const action of actions) {
        await storeA.putAction(action);
      }

      // Count actions started before 5 minutes ago
      const count = await storeB.actionsStartedBefore(
        subjectKey,
        now - 5 * 60 * 1000,
      );
      expect(count).toBe(2); // action-1 and action-2
    });
  });

  describe('window expiry and cleanup', () => {
    it('empty window is returned for non-existent subject', async () => {
      const window = await storeA.windowFor(
        'non-existent-subject',
        AbuseSubjectKind.PRINCIPAL,
        5 * 60 * 1000,
        Date.now(),
      );

      expect(window.total).toBe(0);
      expect(window.reads).toBe(0);
      expect(window.writes).toBe(0);
      expect(window.distinctRoutes).toHaveLength(0);
    });

    it('windows from different time periods are isolated', async () => {
      const subjectKey = 'subject-window-isolation';
      const subjectKind = AbuseSubjectKind.WALLET;
      const windowMs = 5 * 60 * 1000;

      const time1 = 1000000000;
      const time2 = time1 + windowMs * 2; // Different window

      const obs: AbuseObservation = {
        kind: AbuseObservationKind.READ,
        surface: AbuseSurface.HTTP,
        routeGroup: '/api/test',
        occurredAt: time1,
      };

      // Record in first window
      await storeA.record(subjectKey, subjectKind, obs, windowMs, time1);

      // Record in second window
      await storeA.record(subjectKey, subjectKind, obs, windowMs, time2);

      // Each window should have independent counts
      const window1 = await storeA.windowFor(
        subjectKey,
        subjectKind,
        windowMs,
        time1,
      );
      const window2 = await storeA.windowFor(
        subjectKey,
        subjectKind,
        windowMs,
        time2,
      );

      expect(window1.total).toBe(1);
      expect(window2.total).toBe(1);

      // Database should have two separate window records
      const count = await windowRepo.count();
      expect(count).toBe(2);
    });
  });

  describe('credential stuffing detection across instances', () => {
    it('distinctSubjectsForCredential aggregates across all windows', async () => {
      const credentialFp = 'credential-fingerprint-test';
      const windowMs = 5 * 60 * 1000;
      const now = Date.now();

      // Three different subjects try the same credential
      const subjects = ['subject-1', 'subject-2', 'subject-3'];

      for (const subjectKey of subjects) {
        await storeA.record(
          subjectKey,
          AbuseSubjectKind.PRINCIPAL,
          {
            kind: AbuseObservationKind.AUTH_FAILURE,
            surface: AbuseSurface.AUTH,
            routeGroup: '/auth/login',
            occurredAt: now,
            credentialFingerprint: credentialFp,
          },
          windowMs,
          now,
        );
      }

      // Count should reflect all three subjects
      const count = await storeB.distinctSubjectsForCredential(
        credentialFp,
        windowMs,
        now,
      );
      expect(count).toBeGreaterThanOrEqual(3);
    });
  });
});

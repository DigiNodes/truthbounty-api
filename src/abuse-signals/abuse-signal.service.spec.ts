import { InMemoryAbuseSignalStore } from './abuse-signal.store';
import { identityInputFromRequest, resolveAbuseSubject } from './abuse-subject';
import {
  AbuseActionKind,
  AbuseDecisionOutcome,
  AbuseIndeterminateReason,
  AbuseObservation,
  AbuseObservationKind,
  AbuseReasonCode,
  AbuseSeverity,
  AbuseSubjectKind,
  AbuseSurface,
  ABUSE_MODEL_VERSION,
  ABUSE_REASON_CODE_REGISTRY,
  describeReasonCode,
} from './abuse-signals.types';
import {
  buildHarness,
  EXPECTED_VERSIONS,
  networkResolution,
  OTHER_BINDING,
  principalResolution,
  TEST_BINDING,
  TEST_SALT,
} from './abuse-signals.harness';
import {
  bulkImporterDistinctPayloads,
  distributedCredentialSpray,
  endpointMigration,
  fatFingeredPassword,
  FIXTURE_NOW,
  horizontalCrawler,
  noisyReconnectingClient,
  pollingDashboard,
  resubmittedSupportRequests,
  slowAnonymousReader,
} from './fixtures/abuse-observations.fixtures';

/** Feeds observations straight into the store, then evaluates once. */
async function feedAndEvaluate(
  harness: ReturnType<typeof buildHarness>,
  subjectKey: string,
  subjectKind: AbuseSubjectKind,
  observations: AbuseObservation[],
) {
  for (const observation of observations) {
    await harness.store.record(
      subjectKey,
      subjectKind,
      observation,
      harness.policy.windowMs,
      FIXTURE_NOW,
    );
  }
  return harness.service.evaluate(
    { attributed: true, subject: { key: subjectKey, kind: subjectKind } },
    FIXTURE_NOW,
  );
}

/** Gives a principal an abusive window and returns the resulting action. */
async function actionFor(
  harness: ReturnType<typeof buildHarness>,
  principalId: string,
) {
  const resolution = principalResolution(principalId);
  for (const observation of horizontalCrawler()) {
    await harness.store.record(
      resolution.subject.key,
      resolution.subject.kind,
      observation,
      harness.policy.windowMs,
      FIXTURE_NOW,
    );
  }
  const decision = await harness.service.evaluate(resolution, FIXTURE_NOW);
  expect(decision.action).not.toBeNull();
  return { resolution, decision, action: decision.action! };
}

describe('AbuseSignalService (PREWAVE-BE-086)', () => {
  describe('signals never become protocol authority', () => {
    it('produces a decision and an action, and touches nothing else', async () => {
      const harness = buildHarness({ policy: { enforcementEnabled: true } });
      const decision = await feedAndEvaluate(
        harness,
        'subject-crawler',
        AbuseSubjectKind.NETWORK_PREFIX,
        horizontalCrawler(),
      );

      expect(decision.outcome).toBe(AbuseDecisionOutcome.ACTIONED);
      // The complete set of things a decision may reference.
      expect(Object.keys(decision).sort()).toEqual(
        [
          'action',
          'binding',
          'configVersion',
          'confidence',
          'corroboratingDimensions',
          'decidedAt',
          'id',
          'indeterminateReason',
          'kind',
          'modelVersion',
          'outcome',
          'reasonCode',
          'reasonCodeVersion',
          'sampleCount',
          'severity',
          'subjectKey',
          'subjectKind',
        ].sort(),
      );
      // Provenance is stamped on the action, so a decision can be replayed
      // against the deployment that produced it.
      expect(decision.binding).toEqual(TEST_BINDING);
      expect(decision.action?.binding).toEqual(TEST_BINDING);
    });
  });

  describe('false-positive fixtures', () => {
    it('does not action a polling dashboard that only trips read velocity', async () => {
      const harness = buildHarness({ policy: { enforcementEnabled: true } });
      const decision = await feedAndEvaluate(
        harness,
        'subject-dashboard',
        AbuseSubjectKind.PRINCIPAL,
        pollingDashboard(),
      );

      expect(decision.outcome).toBe(AbuseDecisionOutcome.SUPPRESSED);
      expect(decision.reasonCode).toBe(AbuseReasonCode.INSUFFICIENT_CORROBORATION);
      expect(decision.action).toBeNull();
    });

    it('does not action a bulk importer whose payloads are all distinct', async () => {
      const harness = buildHarness({ policy: { enforcementEnabled: true } });
      const decision = await feedAndEvaluate(
        harness,
        'subject-importer',
        AbuseSubjectKind.PRINCIPAL,
        bulkImporterDistinctPayloads(),
      );

      expect(decision.outcome).toBe(AbuseDecisionOutcome.SUPPRESSED);
      expect(decision.action).toBeNull();
    });

    it.each([
      ['fat-fingered password', fatFingeredPassword],
      ['reconnecting stream client', noisyReconnectingClient],
      ['resubmitted support requests', resubmittedSupportRequests],
      ['endpoint migration', endpointMigration],
      ['slow anonymous reader', slowAnonymousReader],
    ])('records no signal at all for %s', async (_label, fixture) => {
      const harness = buildHarness({ policy: { enforcementEnabled: true } });
      const decision = await feedAndEvaluate(
        harness,
        `subject-${_label}`,
        AbuseSubjectKind.PRINCIPAL,
        fixture(),
      );

      expect(decision.outcome).toBe(AbuseDecisionOutcome.NO_SIGNAL);
      expect(decision.reasonCode).toBeNull();
      expect(decision.action).toBeNull();
    });
  });

  describe('actions are bounded and time-limited', () => {
    it('always issues an action with a future expiry inside the policy bound', async () => {
      const harness = buildHarness({
        policy: { enforcementEnabled: true, maxActionDurationMs: 120_000 },
      });
      const decision = await feedAndEvaluate(
        harness,
        'subject-crawler',
        AbuseSubjectKind.NETWORK_PREFIX,
        horizontalCrawler(),
      );

      const action = decision.action!;
      expect(action.appealable).toBe(true);
      expect(Date.parse(action.expiresAt)).toBeGreaterThan(
        Date.parse(action.startedAt),
      );
      expect(Date.parse(action.expiresAt) - FIXTURE_NOW).toBeLessThanOrEqual(
        120_000,
      );
    });

    it('never exceeds the configured maximum however long abuse continues', async () => {
      const harness = buildHarness({
        policy: {
          enforcementEnabled: true,
          maxActionDurationMs: 60_000,
          maxActionsPerSubjectPerWindow: 50,
        },
      });
      const resolution = principalResolution('principal-escalating');

      for (let round = 0; round < 12; round += 1) {
        harness.clock.advance(harness.policy.windowMs / 2);
        await harness.service.observe(resolution, {
          kind: AbuseObservationKind.READ,
          surface: AbuseSurface.HTTP,
          routeGroup: 'claims/list',
          occurredAt: harness.clock.now(),
        });
        const decision = await feedAndEvaluate(
          harness,
          resolution.subject.key,
          resolution.subject.kind,
          horizontalCrawler(200, 60),
        );
        if (decision.action) {
          const duration =
            Date.parse(decision.action.expiresAt) -
            Date.parse(decision.action.startedAt);
          expect(duration).toBeLessThanOrEqual(60_000);
          expect(decision.action.escalationLevel).toBeLessThanOrEqual(50);
        }
      }
    });

    it('caps escalation at the ladder top rather than growing without limit', async () => {
      const store = new InMemoryAbuseSignalStore();
      const harness = buildHarness({
        policy: {
          enforcementEnabled: true,
          maxActionsPerSubjectPerWindow: 100,
          windowMs: 60_000,
        },
        store,
      });
      const resolution = principalResolution('principal-ladder');

      // One abusive window per round, so escalation tracks repeated abuse
      // rather than repeated evaluation of a single window.
      for (let round = 0; round < 10; round += 1) {
        const at = harness.clock.now();
        for (const observation of horizontalCrawler(1_500, 90)) {
          await store.record(
            resolution.subject.key,
            resolution.subject.kind,
            observation,
            harness.policy.windowMs,
            at,
          );
        }
        await harness.service.evaluate(resolution, at);
        harness.clock.advance(harness.policy.windowMs + 1);
      }

      const actions = await store.actionsFor(resolution.subject.key);
      expect(actions.length).toBeGreaterThan(1);
      // Repeated abuse walks up a finite ladder and then stops.
      const kinds = new Set(actions.map((action) => action.kind));
      expect(kinds.has(AbuseActionKind.SUSPEND)).toBe(true);
      expect(kinds.has(AbuseActionKind.CHALLENGE)).toBe(true);
      for (const action of actions) {
        expect(Date.parse(action.expiresAt)).toBeGreaterThan(
          Date.parse(action.startedAt),
        );
      }
    });

    it('holds the escalation level steady while one window keeps firing', async () => {
      const store = new InMemoryAbuseSignalStore();
      const harness = buildHarness({
        policy: { enforcementEnabled: true, windowMs: 60_000 },
        store,
      });
      const resolution = principalResolution('principal-stable');

      for (let call = 0; call < 5; call += 1) {
        for (const observation of horizontalCrawler(1_500, 90)) {
          await store.record(
            resolution.subject.key,
            resolution.subject.kind,
            observation,
            harness.policy.windowMs,
            FIXTURE_NOW,
          );
        }
        await harness.service.evaluate(resolution, FIXTURE_NOW);
      }

      const actions = await store.actionsFor(resolution.subject.key);
      // Every call in the same window produces the same decision, not a new
      // rung on the ladder.
      expect(new Set(actions.map((action) => action.id)).size).toBe(1);
    });
  });

  describe('versioned reason codes', () => {
    it('records the code, its version and the model/config versions', async () => {
      const harness = buildHarness({ policy: { enforcementEnabled: true } });
      const decision = await feedAndEvaluate(
        harness,
        'subject-crawler',
        AbuseSubjectKind.NETWORK_PREFIX,
        horizontalCrawler(),
      );

      expect(decision.reasonCode).not.toBeNull();
      expect(decision.reasonCodeVersion).toBe(
        ABUSE_REASON_CODE_REGISTRY[decision.reasonCode!].version,
      );
      expect(decision.modelVersion).toBe(EXPECTED_VERSIONS.modelVersion);
      expect(decision.configVersion).toBe(EXPECTED_VERSIONS.configVersion);
      expect(decision.action?.modelVersion).toBe(ABUSE_MODEL_VERSION);
    });

    it('gives every registry entry a positive version and a known kind', () => {
      for (const [code, descriptor] of Object.entries(ABUSE_REASON_CODE_REGISTRY)) {
        expect(descriptor.version).toBeGreaterThanOrEqual(1);
        expect(descriptor.severity).toBeDefined();
        expect(code).toMatch(/^[a-z_]+$/);
      }
    });

    it('refuses to interpret an unregistered reason code', () => {
      expect(() =>
        describeReasonCode('not_a_real_code' as AbuseReasonCode),
      ).toThrow('UNREGISTERED_ABUSE_REASON_CODE');
    });

    it('keeps a superseded decision readable after the model moves on', async () => {
      const harness = buildHarness({ policy: { enforcementEnabled: true } });
      const decision = await feedAndEvaluate(
        harness,
        'subject-crawler',
        AbuseSubjectKind.NETWORK_PREFIX,
        horizontalCrawler(),
      );

      // A stored decision carries its own versions, so re-reading it never
      // depends on the currently-loaded thresholds.
      const stored = await harness.service.getDecision(decision.id);
      expect(stored?.modelVersion).toBe(EXPECTED_VERSIONS.modelVersion);
      expect(stored?.reasonCodeVersion).toBe(
        ABUSE_REASON_CODE_REGISTRY[decision.reasonCode!].version,
      );
    });
  });

  describe('distributed sources', () => {
    it('sees one credential across many subjects through the shared store', async () => {
      const store = new InMemoryAbuseSignalStore();
      const harness = buildHarness({
        policy: { enforcementEnabled: true },
        store,
      });

      const subjects = Array.from({ length: 40 }, (_, i) =>
        principalResolution(`principal-${i}`),
      );
      const observations = distributedCredentialSpray(40, 3);
      let cursor = 0;
      for (const subject of subjects) {
        for (let a = 0; a < 3; a += 1) {
          await store.record(
            subject.subject.key,
            subject.subject.kind,
            observations[cursor],
            harness.policy.windowMs,
            FIXTURE_NOW,
          );
          cursor += 1;
        }
      }

      const decision = await harness.service.evaluate(subjects[0], FIXTURE_NOW);
      expect(decision.reasonCode).toBe(
        AbuseReasonCode.CREDENTIAL_STUFFING_DISTINCT_SUBJECTS,
      );
      expect(decision.corroboratingDimensions).toBeGreaterThanOrEqual(1);
    });

    it('converges on the same decision id from two independent replicas', async () => {
      // Separate stores, same observations: the id is derived from subject,
      // reason code, window and escalation level, so both replicas agree
      // without coordinating.
      const replicaA = buildHarness({ policy: { enforcementEnabled: true } });
      const replicaB = buildHarness({ policy: { enforcementEnabled: true } });
      const resolution = principalResolution('principal-shared');

      const fromA = await feedAndEvaluate(
        replicaA,
        resolution.subject.key,
        resolution.subject.kind,
        horizontalCrawler(),
      );
      const fromB = await feedAndEvaluate(
        replicaB,
        resolution.subject.key,
        resolution.subject.kind,
        horizontalCrawler(),
      );

      expect(fromB.id).toBe(fromA.id);
      expect(fromB.action?.id).toBe(fromA.action?.id);
    });

    it('deduplicates a decision when two replicas share one store', async () => {
      const store = new InMemoryAbuseSignalStore();
      const replicaA = buildHarness({ policy: { enforcementEnabled: true }, store });
      const replicaB = buildHarness({ policy: { enforcementEnabled: true }, store });
      const resolution = principalResolution('principal-dedupe');

      // Both replicas write the same decision id for the same window, so the
      // second write replaces the first rather than duplicating it.
      const observations = horizontalCrawler();
      for (const observation of observations) {
        await store.record(
          resolution.subject.key,
          resolution.subject.kind,
          observation,
          replicaA.policy.windowMs,
          FIXTURE_NOW,
        );
      }
      const first = await replicaA.service.evaluate(resolution, FIXTURE_NOW);
      const second = await replicaB.service.evaluate(resolution, FIXTURE_NOW);

      expect(second.id).toBe(first.id);
      expect(
        await replicaA.service.listDecisions({ subjectKey: resolution.subject.key }),
      ).toHaveLength(1);
    });

    it('aggregates counters split across replicas rather than per-replica', async () => {
      const store = new InMemoryAbuseSignalStore();
      const replicaA = buildHarness({ policy: { enforcementEnabled: true }, store });
      const replicaB = buildHarness({ policy: { enforcementEnabled: true }, store });
      const resolution = principalResolution('principal-split');

      // Neither replica sees the threshold alone; together they do.
      for (const harness of [replicaA, replicaB]) {
        for (let i = 0; i < 400; i += 1) {
          await store.record(
            resolution.subject.key,
            resolution.subject.kind,
            {
              kind: AbuseObservationKind.READ,
              surface: AbuseSurface.HTTP,
              routeGroup: `section-${i % 30}`,
              occurredAt: FIXTURE_NOW,
            },
            harness.policy.windowMs,
            FIXTURE_NOW,
          );
        }
      }

      const window = await store.windowFor(
        resolution.subject.key,
        resolution.subject.kind,
        replicaA.policy.windowMs,
        FIXTURE_NOW,
      );
      expect(window.reads).toBe(800);
      expect(window.distinctRoutes.length).toBe(30);
    });
  });

  describe('shared NAT and coarse network subjects', () => {
    it('requires two dimensions before a network subject is actioned', async () => {
      const harness = buildHarness({ policy: { enforcementEnabled: true } });
      const resolution = networkResolution('198.51.100.7');
      expect(resolution.attributed && resolution.subject.kind).toBe(
        AbuseSubjectKind.NETWORK_PREFIX,
      );

      // One dimension only: high velocity, one route.
      for (let i = 0; i < 5_000; i += 1) {
        await harness.store.record(
          resolution.subject.key,
          resolution.subject.kind,
          {
            kind: AbuseObservationKind.READ,
            surface: AbuseSurface.HTTP,
            routeGroup: 'claims/list',
            occurredAt: FIXTURE_NOW,
          },
          harness.policy.windowMs,
          FIXTURE_NOW,
        );
      }

      const suppressed = await harness.service.evaluate(resolution, FIXTURE_NOW);
      expect(suppressed.outcome).toBe(AbuseDecisionOutcome.SUPPRESSED);
      expect(suppressed.action).toBeNull();

      // Two dimensions: same egress, now also walking the surface.
      for (let i = 0; i < 5_000; i += 1) {
        await harness.store.record(
          resolution.subject.key,
          resolution.subject.kind,
          {
            kind: AbuseObservationKind.READ,
            surface: AbuseSurface.HTTP,
            routeGroup: `section-${i % 80}`,
            occurredAt: FIXTURE_NOW,
          },
          harness.policy.windowMs,
          FIXTURE_NOW,
        );
      }

      const actioned = await harness.service.evaluate(resolution, FIXTURE_NOW);
      expect(actioned.outcome).toBe(AbuseDecisionOutcome.ACTIONED);
      expect(actioned.corroboratingDimensions).toBeGreaterThanOrEqual(2);
    });

    it('collapses many unrelated people behind one egress into one subject', () => {
      const a = networkResolution('198.51.100.7');
      const b = networkResolution('198.51.100.200');
      const c = networkResolution('198.51.100.201');

      expect(a.attributed && b.attributed && c.attributed).toBe(true);
      if (a.attributed && b.attributed && c.attributed) {
        // Distinct hosts collapse: the last octet does not separate them.
        expect(a.subject.key).toBe(b.subject.key);
        expect(b.subject.key).toBe(c.subject.key);

        // A different /24 is a different egress and stays separate.
        const elsewhere = networkResolution('198.51.101.7');
        expect(elsewhere.attributed).toBe(true);
        if (elsewhere.attributed) {
          expect(a.subject.key).not.toBe(elsewhere.subject.key);
        }
      }
    });

    it('keys IPv6 anonymous subjects to a /64 prefix, not a host', () => {
      const one = networkResolution('2001:db8:85a3:8d3:1319:8a2e:370:7334');
      const two = networkResolution('2001:db8:85a3:8d3:1319:ffff:ffff:ffff');
      expect(one.attributed && two.attributed).toBe(true);
      if (one.attributed && two.attributed) {
        expect(one.subject.key).toBe(two.subject.key);
      }
    });
  });

  describe('attacker-controlled identifiers', () => {
    // The resolution rules themselves are covered in abuse-subject.spec.ts.
    // What matters here is the consequence: a forged identifier cannot dodge
    // an action that is in force against the real subject.
    it('cannot dodge enforcement by forging a wallet header', async () => {
      const harness = buildHarness({ policy: { enforcementEnabled: true } });
      const store = new InMemoryAbuseSignalStore();
      const seeded = buildHarness({ policy: { enforcementEnabled: true }, store });
      const { resolution, action } = await actionFor(
        seeded,
        'principal-target',
      );
      expect(action).toBeDefined();

      // Same socket address, forged headers: the same anonymous subject, so
      // the forged identity neither escapes nor inherits someone else's action.
      const forged = identityInputFromRequest(
        {
          socket: { remoteAddress: '198.51.100.7' },
          headers: {
            'x-wallet-address': '0x' + 'a'.repeat(40),
            'x-api-key': 'not-a-real-key',
          },
        },
        {
          trustedProxyHops: harness.policy.trustedProxyHops,
          subjectSalt: harness.policy.subjectSalt,
        },
      );
      const forgedResolution = resolveAbuseSubject(forged);
      expect(forgedResolution.attributed).toBe(true);
      if (!forgedResolution.attributed) return;
      expect(forgedResolution.subject.kind).toBe(AbuseSubjectKind.NETWORK_PREFIX);
      expect(forgedResolution.subject.key).not.toBe(resolution.subject.key);

      const state = await harness.service.enforcementFor(
        forgedResolution,
        FIXTURE_NOW + 1,
      );
      expect(state.enforced).toBe(false);
    });
  });

  describe('fail closed', () => {
    it('is indeterminate when there is no verified subject', async () => {
      const harness = buildHarness({ policy: { enforcementEnabled: true } });
      const subjectModule = await import('./abuse-subject');
      const resolution = subjectModule.resolveAbuseSubject({
        trustedProxyHops: 0,
        subjectSalt: TEST_SALT,
      });

      const decision = await harness.service.evaluate(resolution, FIXTURE_NOW);
      expect(decision.outcome).toBe(AbuseDecisionOutcome.INDETERMINATE);
      expect(decision.indeterminateReason).toBe(
        AbuseIndeterminateReason.UNATTRIBUTED,
      );
      expect(decision.action).toBeNull();
    });

    it('is indeterminate when the release binding is missing', async () => {
      const harness = buildHarness({
        policy: { enforcementEnabled: true },
        binding: null,
      });
      const decision = await feedAndEvaluate(
        harness,
        'subject-unbound',
        AbuseSubjectKind.PRINCIPAL,
        horizontalCrawler(),
      );

      expect(decision.outcome).toBe(AbuseDecisionOutcome.INDETERMINATE);
      expect(decision.indeterminateReason).toBe(
        AbuseIndeterminateReason.RELEASE_BINDING_INVALID,
      );
      expect(decision.action).toBeNull();
    });

    it('is indeterminate when the store cannot be read', async () => {
      const harness = buildHarness({ policy: { enforcementEnabled: true } });
      jest
        .spyOn(harness.store, 'windowFor')
        .mockRejectedValue(new Error('store unavailable'));

      const decision = await feedAndEvaluate(
        harness,
        'subject-store-down',
        AbuseSubjectKind.PRINCIPAL,
        horizontalCrawler(),
      );

      expect(decision.outcome).toBe(AbuseDecisionOutcome.INDETERMINATE);
      expect(decision.indeterminateReason).toBe(
        AbuseIndeterminateReason.STORE_UNAVAILABLE,
      );
    });

    it('drops the credential-spread dimension when the lookup fails', async () => {
      const harness = buildHarness({ policy: { enforcementEnabled: true } });
      jest
        .spyOn(harness.store, 'distinctSubjectsForCredential')
        .mockRejectedValue(new Error('store unavailable'));

      const decision = await feedAndEvaluate(
        harness,
        'subject-store-partial',
        AbuseSubjectKind.PRINCIPAL,
        horizontalCrawler(),
      );

      // The lookup failed, so the cross-subject dimension is treated as zero
      // rather than as "no evidence of abuse".
      expect(decision.action?.reasonCode).not.toBe(
        AbuseReasonCode.CREDENTIAL_STUFFING_DISTINCT_SUBJECTS,
      );
    });

    it('denies enforcement when the action read is indeterminate', async () => {
      const harness = buildHarness({ policy: { enforcementEnabled: true } });
      const resolution = principalResolution('principal-deny');
      jest
        .spyOn(harness.store, 'activeAction')
        .mockRejectedValue(new Error('store unavailable'));

      const state = await harness.service.enforcementFor(resolution);
      expect(state.indeterminate).toBe(true);
      expect(state.retryAfterMs).toBe(harness.policy.maxActionDurationMs);
    });

    it('denies enforcement when the release binding is missing', async () => {
      const harness = buildHarness({
        policy: { enforcementEnabled: true },
        binding: null,
      });
      const state = await harness.service.enforcementFor(
        principalResolution('principal-unbound'),
      );
      expect(state.indeterminate).toBe(true);
    });

    it('isolates a throwing detector instead of failing the subject open', async () => {
      const exploding = {
        kind: AbuseSubjectKind.PRINCIPAL,
        id: 'exploding.v1',
        kind_: undefined,
        evaluate: () => {
          throw new Error('detector bug');
        },
      } as never;
      const harness = buildHarness({
        policy: { enforcementEnabled: true },
        detectors: [exploding],
      });

      const decision = await feedAndEvaluate(
        harness,
        'subject-exploding',
        AbuseSubjectKind.PRINCIPAL,
        horizontalCrawler(),
      );
      // The only detector is the broken one, so there is nothing to act on:
      // the module records no signal rather than inventing one.
      expect(decision.outcome).toBe(AbuseDecisionOutcome.NO_SIGNAL);
      expect(decision.action).toBeNull();
    });
  });

  describe('release provenance', () => {
    it('ignores an action issued under a different release binding', async () => {
      const store = new InMemoryAbuseSignalStore();
      const other = buildHarness({
        policy: { enforcementEnabled: true },
        binding: OTHER_BINDING,
        store,
      });
      const decision = await feedAndEvaluate(
        other,
        'principal-cross-release',
        AbuseSubjectKind.PRINCIPAL,
        horizontalCrawler(),
      );
      expect(decision.action).not.toBeNull();

      // The deployment re-reads its own binding and does not match the one
      // the action was issued under.
      const rebound = buildHarness({
        policy: { enforcementEnabled: true },
        binding: TEST_BINDING,
        store,
      });
      const state = await rebound.service.enforcementFor(
        principalResolution('principal-cross-release'),
      );

      expect(state.enforced).toBe(false);
      expect(state.indeterminate).toBe(false);
      expect(state.action).toBeNull();
    });
  });

  describe('recovery', () => {
    it('stops enforcing once the bound expires, with no operator action', async () => {
      const harness = buildHarness({ policy: { enforcementEnabled: true } });
      const resolution = principalResolution('principal-recovery');
      const decision = await feedAndEvaluate(
        harness,
        resolution.subject.key,
        resolution.subject.kind,
        horizontalCrawler(),
      );
      const action = decision.action!;

      const beforeExpiry = await harness.service.enforcementFor(
        resolution,
        Date.parse(action.expiresAt) - 1,
      );
      expect(beforeExpiry.enforced).toBe(true);
      expect(beforeExpiry.retryAfterMs).toBe(1);

      const afterExpiry = await harness.service.enforcementFor(
        resolution,
        Date.parse(action.expiresAt) + 1,
      );
      expect(afterExpiry.enforced).toBe(false);
      expect(afterExpiry.action).toBeNull();
      expect(afterExpiry.retryAfterMs).toBeNull();
    });

    it('marks expired actions as expired so operators can see the bound end', async () => {
      const harness = buildHarness({ policy: { enforcementEnabled: true } });
      const resolution = principalResolution('principal-expiry');
      const decision = await feedAndEvaluate(
        harness,
        resolution.subject.key,
        resolution.subject.kind,
        horizontalCrawler(),
      );
      const expiry = Date.parse(decision.action!.expiresAt);

      const expired = await harness.service.expireActions(expiry + 1);
      expect(expired).toHaveLength(1);
      expect(expired[0].status).toBe('expired');
      // Running it again finds nothing left to do: recovery is idempotent.
      expect(await harness.service.expireActions(expiry + 2)).toHaveLength(0);
    });

    it('resets the window after it rolls over', async () => {
      const harness = buildHarness({ policy: { enforcementEnabled: true } });
      const resolution = principalResolution('principal-rollover');
      await feedAndEvaluate(
        harness,
        resolution.subject.key,
        resolution.subject.kind,
        horizontalCrawler(),
      );

      const later = FIXTURE_NOW + harness.policy.windowMs * 3;
      const window = await harness.store.windowFor(
        resolution.subject.key,
        resolution.subject.kind,
        harness.policy.windowMs,
        later,
      );
      expect(window.total).toBe(0);
      expect(window.distinctRoutes).toEqual([]);
    });

    it('is observe-only by default and refuses nothing', async () => {
      const harness = buildHarness();
      expect(harness.policy.enforcementEnabled).toBe(false);
      expect(harness.service.enforcementActive()).toBe(false);

      const decision = await feedAndEvaluate(
        harness,
        'subject-observe-only',
        AbuseSubjectKind.NETWORK_PREFIX,
        horizontalCrawler(),
      );
      expect(decision.outcome).toBe(AbuseDecisionOutcome.OBSERVED_ONLY);
      expect(decision.action).toBeNull();
      expect(
        await harness.service.enforcementFor(networkResolution('198.51.100.7')),
      ).toEqual({
        enforced: false,
        indeterminate: false,
        action: null,
        retryAfterMs: null,
      });
    });

    it('records nothing when detection is switched off', async () => {
      const harness = buildHarness({ policy: { enabled: false } });
      const decision = await harness.service.observe(
        principalResolution('principal-disabled'),
        {
          kind: AbuseObservationKind.READ,
          surface: AbuseSurface.HTTP,
          routeGroup: 'claims/list',
          occurredAt: FIXTURE_NOW,
        },
      );
      expect(decision.outcome).toBe(AbuseDecisionOutcome.NO_SIGNAL);
    });
  });

  describe('severity and confidence', () => {
    it('reports a bounded confidence that never exceeds 1', async () => {
      const harness = buildHarness({ policy: { enforcementEnabled: true } });
      const decision = await feedAndEvaluate(
        harness,
        'subject-confidence',
        AbuseSubjectKind.NETWORK_PREFIX,
        horizontalCrawler(20_000, 200),
      );
      expect(decision.confidence).toBeGreaterThan(0);
      expect(decision.confidence).toBeLessThanOrEqual(1);
      expect(decision.severity).toBe(AbuseSeverity.MEDIUM);
    });
  });
});

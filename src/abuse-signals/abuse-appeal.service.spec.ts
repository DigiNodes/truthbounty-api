import {
  AbuseAppealService,
  AbuseAppealStatus,
  DEFAULT_ABUSE_APPEAL_POLICY,
  InMemoryAbuseAppealRegister,
} from './abuse-appeal.service';
import { InMemoryAbuseSignalStore } from './abuse-signal.store';
import {
  AbuseActionStatus,
  AbuseObservationKind,
  AbuseSubjectKind,
  AbuseSurface,
} from './abuse-signals.types';
import {
  buildHarness,
  networkResolution,
  principalResolution,
} from './abuse-signals.harness';
import { FIXTURE_NOW, horizontalCrawler } from './fixtures/abuse-observations.fixtures';
import { resolveAbuseSubject } from './abuse-subject';

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

describe('AbuseAppealService (PREWAVE-BE-086)', () => {
  function build() {
    const harness = buildHarness({ policy: { enforcementEnabled: true } });
    const register = new InMemoryAbuseAppealRegister();
    const appeals = new AbuseAppealService(
      harness.service,
      register,
      DEFAULT_ABUSE_APPEAL_POLICY,
    );
    return { harness, register, appeals };
  }

  it('lets a subject appeal their own action', async () => {
    const { appeals, harness } = build();
    const { resolution, action } = await actionFor(harness, 'principal-appellant');

    const appeal = await appeals.submitAppeal(
      { resolution, actionId: action.id, reason: 'This is my monitoring job.' },
      FIXTURE_NOW,
    );

    expect(appeal.status).toBe(AbuseAppealStatus.PENDING);
    expect(appeal.actionId).toBe(action.id);
    expect(appeal.subjectKey).toBe(resolution.subject.key);
    expect(Date.parse(appeal.reviewDueAt)).toBeGreaterThan(FIXTURE_NOW);
  });

  it('refuses an appeal against somebody else’s action', async () => {
    const { appeals, harness } = build();
    const { action } = await actionFor(harness, 'principal-victim');
    const attacker = principalResolution('principal-attacker');

    await expect(
      appeals.submitAppeal(
        { resolution: attacker, actionId: action.id, reason: 'let me off' },
        FIXTURE_NOW,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an appeal when the caller has no verifiable identity', async () => {
    const { appeals } = build();
    const unattributed = resolveAbuseSubject({
      trustedProxyHops: 0,
      subjectSalt: null,
    });

    await expect(
      appeals.submitAppeal(
        { resolution: unattributed, actionId: 'a'.repeat(32), reason: 'hello' },
        FIXTURE_NOW,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('requires a reason, and bounds its length', async () => {
    const { appeals, harness } = build();
    const { resolution, action } = await actionFor(harness, 'principal-reason');

    for (const reason of ['', '   ', 'x'.repeat(501)]) {
      await expect(
        appeals.submitAppeal({ resolution, actionId: action.id, reason }, FIXTURE_NOW),
      ).rejects.toMatchObject({ status: 400 });
    }
  });

  it('refuses a second open appeal for the same action', async () => {
    const { appeals, harness } = build();
    const { resolution, action } = await actionFor(harness, 'principal-duplicate');

    await appeals.submitAppeal(
      { resolution, actionId: action.id, reason: 'first' },
      FIXTURE_NOW,
    );
    await expect(
      appeals.submitAppeal(
        { resolution, actionId: action.id, reason: 'second' },
        FIXTURE_NOW,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('bounds how many open appeals one subject may hold', async () => {
    const store = new InMemoryAbuseSignalStore();
    const harness = buildHarness({ policy: { enforcementEnabled: true }, store });
    const register = new InMemoryAbuseAppealRegister();
    const appeals = new AbuseAppealService(
      harness.service,
      register,
      { reviewSlaMs: 60_000, maxOpenAppealsPerSubject: 2 },
    );

    // Three separate actions for the same subject, across three windows.
    const resolution = principalResolution('principal-flood-appeals');
    const ids: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const at = FIXTURE_NOW + round * (harness.policy.windowMs + 1);
      for (const observation of horizontalCrawler(1_500, 90)) {
        await store.record(
          resolution.subject.key,
          resolution.subject.kind,
          observation,
          harness.policy.windowMs,
          at,
        );
      }
      const decision = await harness.service.evaluate(resolution, at);
      ids.push(decision.action!.id);
    }

    const submitted: string[] = [];
    for (const actionId of ids) {
      try {
        const appeal = await appeals.submitAppeal(
          { resolution, actionId, reason: 'please review' },
          FIXTURE_NOW,
        );
        submitted.push(appeal.id);
      } catch (error) {
        expect(error).toMatchObject({ status: 429 });
      }
    }
    expect(submitted).toHaveLength(2);
  });

  it('pins escalation while an appeal is open instead of lifting the action', async () => {
    const store = new InMemoryAbuseSignalStore();
    const harness = buildHarness({ policy: { enforcementEnabled: true }, store });
    const register = new InMemoryAbuseAppealRegister();
    const appeals = new AbuseAppealService(
      harness.service,
      register,
      DEFAULT_ABUSE_APPEAL_POLICY,
    );
    const { resolution, action } = await actionFor(harness, 'principal-pinned');

    await appeals.submitAppeal(
      { resolution, actionId: action.id, reason: 'let me explain' },
      FIXTURE_NOW,
    );

    // Next abusive window: the action may be renewed, but not grown.
    const later = FIXTURE_NOW + harness.policy.windowMs + 1;
    for (const observation of horizontalCrawler(1_500, 90)) {
      await store.record(
        resolution.subject.key,
        resolution.subject.kind,
        observation,
        harness.policy.windowMs,
        later,
      );
    }
    const renewed = await harness.service.evaluate(resolution, later);

    expect(renewed.action).not.toBeNull();
    expect(renewed.action!.escalationLevel).toBe(action.escalationLevel);
    // Renewed at the same level, so the same duration — never a longer bound.
    expect(Date.parse(renewed.action!.expiresAt)).toBe(
      Date.parse(renewed.action!.startedAt) +
        (Date.parse(action.expiresAt) - Date.parse(action.startedAt)),
    );
  });

  it('lifts enforcement only when an authorised reviewer approves', async () => {
    const store = new InMemoryAbuseSignalStore();
    const harness = buildHarness({ policy: { enforcementEnabled: true }, store });
    const register = new InMemoryAbuseAppealRegister();
    const appeals = new AbuseAppealService(
      harness.service,
      register,
      DEFAULT_ABUSE_APPEAL_POLICY,
    );
    const { resolution, action } = await actionFor(harness, 'principal-approved');

    const appeal = await appeals.submitAppeal(
      { resolution, actionId: action.id, reason: 'false positive' },
      FIXTURE_NOW,
    );

    // No reviewer identity is refused fail-closed.
    await expect(
      appeals.decideAppeal({ appealId: appeal.id, approved: true, reviewerId: '' }, FIXTURE_NOW),
    ).rejects.toMatchObject({ status: 403 });

    const decided = await appeals.decideAppeal(
      { appealId: appeal.id, approved: true, reviewerId: 'admin-1', note: 'ok' },
      FIXTURE_NOW,
    );
    expect(decided.status).toBe(AbuseAppealStatus.APPROVED);
    expect(decided.decidedBy).toBe('admin-1');

    const stored = await store.getAction(action.id);
    expect(stored?.status).toBe(AbuseActionStatus.LIFTED);
    const state = await harness.service.enforcementFor(resolution, FIXTURE_NOW + 1);
    expect(state.enforced).toBe(false);
  });

  it('keeps enforcement in place when an appeal is rejected', async () => {
    const store = new InMemoryAbuseSignalStore();
    const harness = buildHarness({ policy: { enforcementEnabled: true }, store });
    const register = new InMemoryAbuseAppealRegister();
    const appeals = new AbuseAppealService(
      harness.service,
      register,
      DEFAULT_ABUSE_APPEAL_POLICY,
    );
    const { resolution, action } = await actionFor(harness, 'principal-rejected');

    const appeal = await appeals.submitAppeal(
      { resolution, actionId: action.id, reason: 'not me' },
      FIXTURE_NOW,
    );
    await appeals.decideAppeal(
      { appealId: appeal.id, approved: false, reviewerId: 'admin-1' },
      FIXTURE_NOW,
    );

    const stored = await store.getAction(action.id);
    expect(stored?.status).toBe(AbuseActionStatus.ACTIVE);
    const state = await harness.service.enforcementFor(resolution, FIXTURE_NOW + 1);
    expect(state.enforced).toBe(true);
  });

  it('refuses to decide an appeal twice', async () => {
    const { appeals, harness } = build();
    const { resolution, action } = await actionFor(harness, 'principal-twice');
    const appeal = await appeals.submitAppeal(
      { resolution, actionId: action.id, reason: 'once' },
      FIXTURE_NOW,
    );
    await appeals.decideAppeal(
      { appealId: appeal.id, approved: true, reviewerId: 'admin-1' },
      FIXTURE_NOW,
    );
    await expect(
      appeals.decideAppeal(
        { appealId: appeal.id, approved: false, reviewerId: 'admin-2' },
        FIXTURE_NOW,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('releases the escalation pin once the review SLA elapses', async () => {
    const store = new InMemoryAbuseSignalStore();
    const harness = buildHarness({ policy: { enforcementEnabled: true }, store });
    const register = new InMemoryAbuseAppealRegister();
    const appeals = new AbuseAppealService(
      harness.service,
      register,
      { reviewSlaMs: 3_600_000, maxOpenAppealsPerSubject: 2 },
    );
    const { resolution, action } = await actionFor(harness, 'principal-expired');

    await appeals.submitAppeal(
      { resolution, actionId: action.id, reason: 'awaiting review' },
      FIXTURE_NOW,
    );
    // Pinned: the next window does not escalate.
    const later = FIXTURE_NOW + harness.policy.windowMs + 1;
    for (const observation of horizontalCrawler(1_500, 90)) {
      await store.record(
        resolution.subject.key,
        resolution.subject.kind,
        observation,
        harness.policy.windowMs,
        later,
      );
    }
    const pinned = await harness.service.evaluate(resolution, later);
    expect(pinned.action!.escalationLevel).toBe(action.escalationLevel);

    // After the SLA, the pin is released and escalation resumes.
    const released = appeals.releaseExpiredAppeals(
      resolution.subject.key,
      FIXTURE_NOW + 3_600_001,
    );
    expect(released).toHaveLength(1);
    expect(released[0].status).toBe(AbuseAppealStatus.EXPIRED);

    const next = later + harness.policy.windowMs + 1;
    for (const observation of horizontalCrawler(1_500, 90)) {
      await store.record(
        resolution.subject.key,
        resolution.subject.kind,
        observation,
        harness.policy.windowMs,
        next,
      );
    }
    const resumed = await harness.service.evaluate(resolution, next);
    expect(resumed.action!.escalationLevel).toBeGreaterThan(
      action.escalationLevel,
    );
  });

  it('never stores personal data beyond the appellant’s own words', async () => {
    const { appeals, harness } = build();
    const { resolution, action } = await actionFor(harness, 'principal-privacy');
    const appeal = await appeals.submitAppeal(
      { resolution, actionId: action.id, reason: 'I run a read-only monitor' },
      FIXTURE_NOW,
    );

    const serialized = JSON.stringify(appeal);
    expect(serialized).not.toMatch(/0x[0-9a-f]{40}/i);
    expect(serialized).not.toMatch(
      /authorization|bearer|private[-_ ]?key|seed phrase|password/i,
    );
    expect(appeal.subjectKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps a network subject appealable without naming the host', async () => {
    const store = new InMemoryAbuseSignalStore();
    const harness = buildHarness({ policy: { enforcementEnabled: true }, store });
    const register = new InMemoryAbuseAppealRegister();
    const appeals = new AbuseAppealService(
      harness.service,
      register,
      DEFAULT_ABUSE_APPEAL_POLICY,
    );
    const resolution = networkResolution('198.51.100.7');
    if (!resolution.attributed) throw new Error('expected a subject');

    for (const observation of horizontalCrawler()) {
      await store.record(
        resolution.subject.key,
        resolution.subject.kind,
        observation,
        harness.policy.windowMs,
        FIXTURE_NOW,
      );
    }
    const decision = await harness.service.evaluate(resolution, FIXTURE_NOW);
    const appeal = await appeals.submitAppeal(
      {
        resolution,
        actionId: decision.action!.id,
        reason: 'shared office egress',
      },
      FIXTURE_NOW,
    );

    expect(appeal.subjectKey).not.toContain('198.51.100.7');
    expect(decision.subjectKind).toBe(AbuseSubjectKind.NETWORK_PREFIX);
  });

  it('records observations without leaking the observation shape', async () => {
    const harness = buildHarness();
    const decision = await harness.service.observe(
      principalResolution('principal-observe'),
      {
        kind: AbuseObservationKind.READ,
        surface: AbuseSurface.HTTP,
        routeGroup: 'claims/list',
        occurredAt: FIXTURE_NOW,
      },
    );
    expect(JSON.stringify(decision, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    )).not.toMatch(/routeGroup|credentialFingerprint/);
  });
});
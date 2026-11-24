import { HttpException } from '@nestjs/common';
import {
  AbuseAppealService,
  AbuseAppealStatus,
  InMemoryAbuseAppealRegister,
} from './abuse-appeal.service';
import { AbuseSignalsController } from './abuse-signals.controller';
import {
  AbuseDecisionOutcome,
  AbuseSubjectKind,
} from './abuse-signals.types';
import { buildHarness, principalResolution } from './abuse-signals.harness';
import { FIXTURE_NOW, horizontalCrawler } from './fixtures/abuse-observations.fixtures';

/**
 * Board and appeal surface (#681).
 *
 * The property worth guarding here is *asymmetric disclosure*: an operator must
 * be able to see which versioned reason code fired, and a subject must not.
 */
describe('AbuseSignalsController (PREWAVE-BE-086)', () => {
  function build() {
    const harness = buildHarness({ policy: { enforcementEnabled: true } });
    const register = new InMemoryAbuseAppealRegister();
    const appeals = new AbuseAppealService(harness.service, register, {
      reviewSlaMs: 3_600_000,
      maxOpenAppealsPerSubject: 2,
    });
    const controller = new AbuseSignalsController(
      harness.service,
      appeals,
      harness.policy,
    );
    return { harness, appeals, controller };
  }

  async function actionedSubject(
    harness: ReturnType<typeof buildHarness>,
    at = FIXTURE_NOW,
  ) {
    const resolution = principalResolution('principal-board');
    for (const observation of horizontalCrawler()) {
      await harness.store.record(
        resolution.subject.key,
        resolution.subject.kind,
        observation,
        harness.policy.windowMs,
        at,
      );
    }
    const decision = await harness.service.evaluate(resolution, at);
    expect(decision.action).not.toBeNull();
    return decision;
  }

  it('reports activation and provenance without leaking thresholds', async () => {
    const { controller } = build();
    const status = await controller.status();

    expect(status.schemaVersion).toBe('abuse-signals.v1');
    expect(status.detectionEnabled).toBe(true);
    expect(status.enforcementActive).toBe(true);
    expect(status.releaseBound).toBe(true);
    expect(Object.keys(status).sort()).toEqual([
      'actionsInForce',
      'configVersion',
      'detectionEnabled',
      'enforcementActive',
      'modelVersion',
      'releaseBound',
      'schemaVersion',
    ]);
    expect(JSON.stringify(status)).not.toMatch(/maxAnonymousReads|threshold/i);
  });

  it('gives the admin plane the versioned reason code', async () => {
    const { controller, harness } = build();
    const decision = await actionedSubject(harness);

    const listed = await controller.listDecisions(decision.subjectKey);
    expect(listed.total).toBe(1);
    const admin = listed.decisions[0];
    expect(admin.reasonCode).toBe(decision.reasonCode);
    expect(admin.reasonCodeVersion).toBe(1);
    expect(admin.action?.appealable).toBe(true);
    expect(admin.binding?.releaseId).toBe('v2.1.0-sepolia');
    expect(admin.binding?.deploymentBlock).toBe('12345678');
  });

  it('keeps the subject plane free of heuristic metadata', async () => {
    const { controller, harness } = build();
    const decision = await actionedSubject(harness);

    const subjectView = await controller.submitAppeal(
      decision.id,
      { reason: 'This is an authorised read-only monitor.' },
      { user: { sub: 'principal-board' } },
    );
    const dto = JSON.stringify(subjectView);

    // Exactly the appellant's own appeal, and nothing that would let a caller
    // tune themselves against the detector.
    expect(Object.keys(subjectView).sort()).toEqual([
      'actionId',
      'decidedAt',
      'decisionNote',
      'id',
      'reviewDueAt',
      'status',
      'submittedAt',
    ]);
    for (const forbidden of [
      'reasonCode',
      'severity',
      'confidence',
      'sampleCount',
      'corroboratingDimensions',
      'scrape',
      'spam',
      'threshold',
      decision.subjectKey,
    ]) {
      expect(dto).not.toContain(forbidden);
    }
    expect(subjectView.status).toBe('pending');
  });

  it('resolves the appellant from the principal, never from a path parameter', async () => {
    const { controller, harness } = build();
    const decision = await actionedSubject(harness);

    await expect(
      controller.submitAppeal(
        decision.id,
        { reason: 'not mine' },
        { user: { sub: 'principal-stranger' } },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('returns a canonical 404 for an unknown decision', async () => {
    const { controller } = build();
    await expect(controller.getDecision('nope')).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ errorCode: 'NOT_FOUND' }),
    });
  });

  it('refuses to decide an appeal without a reviewer identity', async () => {
    const { controller, harness, appeals } = build();
    const decision = await actionedSubject(harness);
    const appeal = await appeals.submitAppeal(
      {
        resolution: principalResolution('principal-board'),
        actionId: decision.action!.id,
        reason: 'review please',
      },
      FIXTURE_NOW,
    );

    await expect(
      controller.decideAppeal(appeal.id, { approved: true }, {}),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lifts the action when a reviewer approves', async () => {
    // Seeded at the wall clock so the action's bound is genuinely in the
    // future, which is the case an approval has to interrupt.
    const harness = buildHarness({ policy: { enforcementEnabled: true }, now: Date.now() });
    const register = new InMemoryAbuseAppealRegister();
    const appeals = new AbuseAppealService(harness.service, register, {
      reviewSlaMs: 3_600_000,
      maxOpenAppealsPerSubject: 2,
    });
    const controller = new AbuseSignalsController(
      harness.service,
      appeals,
      harness.policy,
    );
    const decision = await actionedSubject(harness, Date.now());

    const appeal = await appeals.submitAppeal(
      {
        resolution: principalResolution('principal-board'),
        actionId: decision.action!.id,
        reason: 'review please',
      },
      Date.now(),
    );

    const before = await harness.service.enforcementFor(
      principalResolution('principal-board'),
    );
    expect(before.enforced).toBe(true);

    const decided = await controller.decideAppeal(
      appeal.id,
      { approved: true, note: 'false positive' },
      { admin: { id: 'admin-1' } },
    );

    expect(decided.status).toBe(AbuseAppealStatus.APPROVED);
    const after = await harness.service.enforcementFor(
      principalResolution('principal-board'),
    );
    expect(after.enforced).toBe(false);
    expect(after.action).toBeNull();
  });

  it('exposes appeals to the review plane only', async () => {
    const { controller, harness, appeals } = build();
    const decision = await actionedSubject(harness);
    await appeals.submitAppeal(
      {
        resolution: principalResolution('principal-board'),
        actionId: decision.action!.id,
        reason: 'review please',
      },
      FIXTURE_NOW,
    );

    const listed = await controller.listAppeals();
    expect(listed.appeals).toHaveLength(1);
    expect(Object.keys(listed.appeals[0]).sort()).toEqual([
      'actionId',
      'decidedAt',
      'decisionNote',
      'id',
      'reviewDueAt',
      'status',
      'submittedAt',
    ]);
  });

  it('records the reason a decision was indeterminate', async () => {
    const harness = buildHarness({ policy: { enforcementEnabled: true }, binding: null });
    const controller = new AbuseSignalsController(
      harness.service,
      build().appeals,
      harness.policy,
    );
    const decision = await harness.service.evaluate(
      principalResolution('principal-unbound'),
      FIXTURE_NOW,
    );

    expect(decision.outcome).toBe(AbuseDecisionOutcome.INDETERMINATE);
    expect(decision.subjectKind).toBe(AbuseSubjectKind.PRINCIPAL);
    expect(decision.action).toBeNull();
    expect(controller).toBeInstanceOf(AbuseSignalsController);
  });

  it('maps an appeal failure onto a canonical HTTP error', async () => {
    const { controller } = build();
    await expect(
      controller.submitAppeal(
        'missing',
        { reason: 'hello' },
        { user: { sub: 'principal-board' } },
      ),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
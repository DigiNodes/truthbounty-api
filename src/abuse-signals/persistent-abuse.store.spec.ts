import { AbuseAppeal, AbuseAppealStatus } from './abuse-appeal.service';
import { AbuseAppealRecord } from './entities/abuse-appeal-record.entity';
import { AbuseAppealDecisionHistoryRecord } from './entities/abuse-appeal-decision-history.entity';
import {
  TypeOrmAbuseAppealRegister,
  TypeOrmAbuseSignalStore,
} from './persistent-abuse.store';
import {
  AbuseActionKind,
  AbuseActionStatus,
  AbuseDecisionOutcome,
  AbuseReasonCode,
  AbuseSubjectKind,
} from './abuse-signals.types';

function appeal(overrides: Partial<AbuseAppeal> = {}): AbuseAppeal {
  return {
    id: 'appeal-subject-action',
    actionId: 'action-1',
    subjectKey: 'a'.repeat(64),
    reason: 'The action is incorrect.',
    status: AbuseAppealStatus.PENDING,
    submittedAt: '2026-01-01T00:00:00.000Z',
    reviewDueAt: '2026-01-03T00:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    ...overrides,
  };
}

function repository(initial: any[] = []) {
  const rows = [...initial];
  return {
    rows,
    findOne: jest.fn(
      async ({ where }: any) =>
        rows.find((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value),
        ) ?? null,
    ),
    find: jest.fn(async ({ where = {} }: any = {}) =>
      rows.filter((row) =>
        Object.entries(where).every(([key, value]) => row[key] === value),
      ),
    ),
    count: jest.fn(
      async ({ where }: any) =>
        rows.filter((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value),
        ).length,
    ),
    insert: jest.fn(async (row: any) => rows.push(row)),
    update: jest.fn(async (_where: any, patch: any) => {
      const row = rows[0];
      if (!row) return { affected: 0 };
      Object.assign(row, patch);
      return { affected: 1 };
    }),
    createQueryBuilder: jest.fn(),
  };
}

function transactional(repositoryMap: Map<unknown, any>) {
  const manager: any = {
    query: jest.fn().mockResolvedValue([]),
    getRepository: jest.fn((entity: unknown) => repositoryMap.get(entity)),
  };
  manager.transaction = jest.fn(async (callback: (tx: any) => Promise<void>) =>
    callback(manager),
  );
  return manager;
}

describe('durable abuse-signal persistence adapters', () => {
  it('serializes pending submissions and enforces the open-appeal limit in the transaction', async () => {
    const appeals = repository();
    const history = repository();
    const manager = transactional(
      new Map<unknown, any>([
        [AbuseAppealRecord, appeals],
        [AbuseAppealDecisionHistoryRecord, history],
      ]),
    );
    (appeals as any).manager = manager;

    const register = new TypeOrmAbuseAppealRegister(appeals as any);
    await register.putPending(appeal(), 2);

    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [appeal().subjectKey],
    );
    expect(appeals.insert).toHaveBeenCalledTimes(1);
  });

  it('records a terminal decision and its audit row atomically', async () => {
    const pending = appeal();
    const appeals = repository([
      {
        ...pending,
        submittedAt: new Date(pending.submittedAt),
        reviewDueAt: new Date(pending.reviewDueAt),
        decidedAt: null,
      },
    ]);
    const history = repository();
    const manager = transactional(
      new Map<unknown, any>([
        [AbuseAppealRecord, appeals],
        [AbuseAppealDecisionHistoryRecord, history],
      ]),
    );
    (appeals as any).manager = manager;

    const register = new TypeOrmAbuseAppealRegister(appeals as any);
    await register.put(
      appeal({
        status: AbuseAppealStatus.APPROVED,
        decidedAt: '2026-01-02T00:00:00.000Z',
        decidedBy: 'reviewer-1',
        decisionNote: 'Verified by the reviewer.',
      }),
    );

    expect(appeals.update).toHaveBeenCalledTimes(1);
    expect(history.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        appealId: pending.id,
        status: AbuseAppealStatus.APPROVED,
        decidedBy: 'reviewer-1',
      }),
    );
  });

  it('makes decision writes idempotent and reconstructs persisted actions', async () => {
    const decisions = repository();
    const action = {
      id: 'action-1',
      subjectKey: 'a'.repeat(64),
      subjectKind: AbuseSubjectKind.PRINCIPAL,
      kind: AbuseActionKind.THROTTLE,
      status: AbuseActionStatus.ACTIVE,
      reasonCode: AbuseReasonCode.SCRAPE_HIGH_BREADTH_ANONYMOUS,
      reasonCodeVersion: 1,
      modelVersion: 'abuse-model.v1',
      configVersion: 'abuse-config.v1',
      bindingChainId: 1,
      releaseId: 'release-1',
      deploymentBlock: '42',
      artifactChecksum: 'b'.repeat(64),
      costMultiplier: 4,
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-01T01:00:00.000Z'),
      appealable: true,
      escalationLevel: 0,
    };
    const actions = repository([action]);
    const store = new TypeOrmAbuseSignalStore(decisions as any, actions as any);
    const decision = {
      id: 'decision-1',
      subjectKey: action.subjectKey,
      subjectKind: AbuseSubjectKind.PRINCIPAL,
      outcome: AbuseDecisionOutcome.ACTIONED,
      indeterminateReason: null,
      reasonCode: action.reasonCode,
      reasonCodeVersion: 1,
      kind: null,
      severity: null,
      confidence: 1,
      sampleCount: 2,
      corroboratingDimensions: 2,
      modelVersion: action.modelVersion,
      configVersion: action.configVersion,
      binding: {
        chainId: 1,
        releaseId: action.releaseId,
        deploymentBlock: 42n,
        artifactChecksum: action.artifactChecksum,
      },
      action: {
        ...action,
        startedAt: action.startedAt.toISOString(),
        expiresAt: action.expiresAt.toISOString(),
        binding: {
          chainId: 1,
          releaseId: action.releaseId,
          deploymentBlock: 42n,
          artifactChecksum: action.artifactChecksum,
        },
      },
      decidedAt: '2026-01-01T00:00:00.000Z',
    } as any;

    await store.recordDecision(decision);
    await store.recordDecision(decision);

    expect(decisions.insert).toHaveBeenCalledTimes(1);
    expect((await store.getDecision(decision.id))?.action?.id).toBe(action.id);
  });
});

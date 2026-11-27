import 'reflect-metadata';
import {
  BadRequestException, ConflictException, ForbiddenException,
  NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { AdminAuditService } from '../../audit/services/admin-audit.service';
import { AdminActionType } from '../../audit/admin-audit.types';
import { AiBudgetAdminService } from './ai-budget-admin.service';
import { AiBudgetService } from './ai-budget.service';
import { AiBudgetOverrideInput, AiBudgetPriceInput, AiBudgetRule } from './ai-budget.types';

const actor = { id: '11111111-1111-4111-8111-111111111111', role: 'admin' };
const userId = '22222222-2222-4222-8222-222222222222';
const policyId = '33333333-3333-4333-8333-333333333333';
const coverageStart = new Date('2026-10-01T00:00:00.000Z');
const databaseNow = new Date('2026-11-21T12:00:00.000Z');
const rules: readonly AiBudgetRule[] = [
  { scope: 'user', subject: '*', window: 'day', tokenLimit: '10000000', spendLimitUsdNanos: '1000000000000' },
  { scope: 'user', subject: '*', window: 'month', tokenLimit: '100000000', spendLimitUsdNanos: '10000000000000' },
  { scope: 'global', subject: '*', window: 'day', tokenLimit: '10000000', spendLimitUsdNanos: '1000000000000' },
  { scope: 'global', subject: '*', window: 'month', tokenLimit: '100000000', spendLimitUsdNanos: '10000000000000' },
  { scope: 'provider', subject: 'openai', window: 'day', tokenLimit: '10000000', spendLimitUsdNanos: '1000000000000' },
  { scope: 'provider', subject: 'openai', window: 'month', tokenLimit: '100000000', spendLimitUsdNanos: '10000000000000' },
  { scope: 'provider', subject: 'anthropic', window: 'day', tokenLimit: '10000000', spendLimitUsdNanos: '1000000000000' },
  { scope: 'provider', subject: 'anthropic', window: 'month', tokenLimit: '100000000', spendLimitUsdNanos: '10000000000000' },
];
const price: AiBudgetPriceInput = {
  provider: 'openai', model: 'gpt-4o-mini', inputNanos: '150',
  outputNanos: '600', cachedInputNanos: '75', changeReference: 'OPS-818',
};
const override: AiBudgetOverrideInput = {
  userId, window: 'day', extraTokens: '1000', extraSpendUsdNanos: '1000000000',
  expiresAt: '2026-11-21T23:00:00.000Z', changeReference: 'OPS-818',
};
type Row = Record<string, any>;
interface State {
  readonly authority: Row;
  readonly policies: readonly Row[];
  readonly prices: readonly Row[];
  readonly overrides: readonly Row[];
  readonly attempts: readonly Row[];
  readonly audits: readonly Row[];
  readonly head: Row;
}
const initial = (): State => ({
  authority: { id: 1, policy_version: policyId, coverage_start: coverageStart, halted: false },
  policies: [{ id: policyId, rules }],
  prices: [], overrides: [],
  attempts: [{ id: userId, charged_tokens: '4321', charged_nanos: '98765', state: 'held' }],
  audits: [], head: { id: 1, lastSequence: '0', lastHash: null },
});

/** Database boundary only: execute and withAuthority use their real public implementations. */
function database() {
  let committed = initial();
  let now = databaseNow;
  let rejectSuccess = false;
  let rejectAttempt = false;
  let queries: readonly { sql: string; parameters: readonly any[]; manager: EntityManager }[] = [];
  let headReads: readonly { manager: EntityManager; options: unknown }[] = [];
  const source = { options: { type: 'postgres' }, isInitialized: true } as unknown as DataSource;

  function priceQuery(state: State, parameters: readonly any[]): State {
    const [id, provider, model, input_nanos, output_nanos, cached_input_nanos, created_at, actor_id, change_reference] = parameters;
    return { ...state, prices: [...state.prices, {
      id, provider, model, input_nanos, output_nanos, cached_input_nanos,
      created_at, actor_id, change_reference,
    }] };
  }

  function overrideQuery(state: State, parameters: readonly any[]): State {
    const [id, user_id, window, window_start, extra_tokens, extra_nanos, expires_at, created_at, actor_id, change_reference] = parameters;
    return { ...state, overrides: [...state.overrides, {
      id, user_id, window, window_start, extra_tokens, extra_nanos,
      expires_at, created_at, actor_id, change_reference, revoked_at: null,
    }] };
  }

  function selectOverrides(state: State, sql: string, parameters: readonly any[]): Row[] {
    if (/WHERE\s+id\s*=/i.test(sql)) {
      return state.overrides.filter((row) => row.id === parameters[0]).map((row) => ({ ...row }));
    }
    const [id, window, start, at] = parameters;
    return state.overrides.filter((row) =>
      row.user_id === id && row.window === window &&
      new Date(row.window_start).getTime() === new Date(start).getTime() &&
      row.revoked_at === null && new Date(row.expires_at) > new Date(at),
    ).map((row) => ({ ...row }));
  }

  function runner() {
    let working = committed;
    const unit: any = {
      connection: source, isTransactionActive: false, isReleased: false,
      connect: async () => undefined,
      startTransaction: async () => { working = committed; unit.isTransactionActive = true; },
      commitTransaction: async () => { committed = working; unit.isTransactionActive = false; },
      rollbackTransaction: async () => { unit.isTransactionActive = false; },
      release: async () => { unit.isReleased = true; },
    };
    const manager: any = {
      connection: source, queryRunner: unit,
      findOneOrFail: async (_entity: unknown, options: unknown) => {
        headReads = [...headReads, { manager, options }];
        return { ...working.head };
      },
      create: (_entity: unknown, input: Row) => ({ ...input }),
      save: async (row: Row) => {
        if (row.chainSequence !== undefined) {
          if ((rejectSuccess && row.outcome === 'success') || (rejectAttempt && row.outcome === 'attempted')) {
            throw new Error('audit unavailable');
          }
          working = { ...working, audits: [...working.audits, { ...row }] };
        } else working = { ...working, head: { ...row } };
        return row;
      },
    };
    manager.query = async (sql: string, parameters: readonly any[] = []) => {
      queries = [...queries, { sql, parameters, manager }];
      const response = query(working, sql, parameters);
      working = response.state;
      return response.rows;
    };
    unit.manager = manager;
    return unit;
  }

  function query(state: State, sql: string, parameters: readonly any[]): { state: State; rows: Row[] } {
    if (/clock_timestamp/i.test(sql)) return { state, rows: [{ now, database_now: now, timestamp: now }] };
    if (/FROM\s+"?ai_budget_authority"?/i.test(sql)) return { state, rows: [{ ...state.authority }] };
    if (/INSERT INTO\s+"?ai_budget_prices"?/i.test(sql)) return { state: priceQuery(state, parameters), rows: [] };
    if (/INSERT INTO\s+"?ai_budget_policies"?/i.test(sql)) {
      const [id, rawRules, created_at, actor_id, change_reference] = parameters;
      return { state: { ...state, policies: [...state.policies, {
        id, rules: JSON.parse(rawRules), created_at, actor_id, change_reference,
      }] }, rows: [] };
    }
    if (/UPDATE\s+"?ai_budget_authority"?/i.test(sql)) {
      const authority = /policy_version/i.test(sql)
        ? { ...state.authority, policy_version: parameters[0] }
        : { ...state.authority, coverage_start: parameters[0] };
      return { state: { ...state, authority }, rows: [] };
    }
    if (/FROM\s+"?ai_budget_policies"?/i.test(sql)) {
      return { state, rows: state.policies.filter((row) => row.id === parameters[0]).map((row) => ({ ...row })) };
    }
    if (/INSERT INTO\s+"?ai_budget_overrides"?/i.test(sql)) return { state: overrideQuery(state, parameters), rows: [] };
    if (/FROM\s+"?ai_budget_overrides"?/i.test(sql)) return { state, rows: selectOverrides(state, sql, parameters) };
    if (/UPDATE\s+"?ai_budget_overrides"?/i.test(sql)) {
      return { state: { ...state, overrides: state.overrides.map((row) =>
        row.id === parameters[0] ? { ...row, revoked_at: parameters[1] } : row,
      ) }, rows: [] };
    }
    throw new Error('Unsupported database fixture query');
  }

  (source as any).createQueryRunner = runner;
  (source as any).transaction = async (work: (manager: EntityManager) => Promise<unknown>) => {
    const unit = runner();
    await unit.startTransaction();
    try {
      const result = await work(unit.manager);
      await unit.commitTransaction();
      return result;
    } catch (error) {
      await unit.rollbackTransaction();
      throw error;
    }
  };
  return {
    source, state: () => committed, queries: () => queries, headReads: () => headReads,
    replace: (value: State) => { committed = value; },
    clock: (value: Date) => { now = value; },
    failSuccessAudit: () => { rejectSuccess = true; },
    failAttemptAudit: () => { rejectAttempt = true; },
  };
}
function setup(ids: string | undefined = actor.id) {
  const db = database();
  const config = new ConfigService(ids === undefined ? {} : { AI_BUDGET_OPERATOR_IDS: ids });
  const budget = new AiBudgetService(db.source);
  const audit = new AdminAuditService(db.source, config);
  return { db, service: new AiBudgetAdminService(db.source, config, audit, budget) };
}

describe('AI budget administration', () => {
  it.each([
    { id: actor.id, role: 'contributor' },
    { id: actor.id, role: 'moderator' },
    { id: userId, role: 'admin' },
    { id: 'not-a-uuid', role: 'admin' },
  ])('rejects unauthorized server actor %j before any durable work', async (unauthorized) => {
    const { db, service } = setup();
    await expect(service.createPrice(unauthorized, price)).rejects.toThrow(ForbiddenException);
    expect(db.state().audits).toHaveLength(0);
    expect(db.state().prices).toHaveLength(0);
  });

  it('denies all writes with the default empty operator configuration', async () => {
    const db = database();
    const config = new ConfigService();
    const service = new AiBudgetAdminService(
      db.source, config, new AdminAuditService(db.source, config), new AiBudgetService(db.source),
    );
    await expect(service.beginCoverage(actor, { changeReference: 'OPS-818' }))
      .rejects.toThrow(ForbiddenException);
    expect(db.state().audits).toHaveLength(0);
  });

  it('appends price versions and leaves original prices and consumption unchanged', async () => {
    const { db, service } = setup();
    const first = await service.createPrice(actor, price);
    const second = await service.createPrice(actor, { ...price, inputNanos: '200' });
    expect(second.id).not.toBe(first.id);
    expect(db.state().prices.map((row) => row.input_nanos)).toEqual(['150', '200']);
    expect(db.state().attempts).toEqual(initial().attempts);
    expect(db.state().authority).toEqual(initial().authority);
  });

  it.each([
    { ...price, provider: 'anthropic' },
    { ...price, model: 'client-selected-model' },
    { ...price, inputNanos: '0' },
    { ...price, outputNanos: '0' },
    { ...price, inputNanos: '1000000001' },
    { ...price, cachedInputNanos: '151' },
    { ...price, inputNanos: '0150' },
    { ...price, inputNanos: 150 },
  ])('revalidates price bounds and server model selection %j', async (input) => {
    const { db, service } = setup();
    await expect(service.createPrice(actor, input as AiBudgetPriceInput))
      .rejects.toThrow(BadRequestException);
    expect(db.state().prices).toHaveLength(0);
    expect(db.state().audits).toHaveLength(0);
  });

  it('permits zero output pricing only for the supported embedding model', async () => {
    const { db, service } = setup();
    await service.createPrice(actor, {
      ...price, model: 'text-embedding-3-small', inputNanos: '20', outputNanos: '0', cachedInputNanos: '0',
    });
    expect(db.state().prices[0].output_nanos).toBe('0');
  });

  it('activates immutable policies without resetting coverage, halt or charged attempts', async () => {
    const { db, service } = setup();
    db.replace({ ...db.state(), authority: { ...db.state().authority, halted: true } });
    const first = await service.activatePolicy(actor, { rules, changeReference: 'OPS-818' });
    const changed = rules.map((rule) => ({ ...rule, tokenLimit: '200000000' }));
    const second = await service.activatePolicy(actor, { rules: changed, changeReference: 'OPS-819' });
    expect(second.id).not.toBe(first.id);
    expect(db.state().policies[1].rules[0].tokenLimit).toBe('10000000');
    expect(db.state().authority).toEqual({
      ...initial().authority, halted: true, policy_version: second.id,
    });
    expect(db.state().attempts).toEqual(initial().attempts);
  });

  it.each([
    { name: 'no rules', invalid: [] },
    { name: 'missing rules', invalid: [rules[0]] },
    { name: 'duplicate rules', invalid: [...rules, rules[0]] },
    {
      name: 'an out-of-range token limit',
      invalid: rules.map((rule) => ({ ...rule, tokenLimit: '9000000000000000001' })),
    },
    {
      name: 'an unknown scope',
      invalid: rules.map((rule) => ({ ...rule, scope: 'client' })),
    },
  ])('rejects a policy with $name', async ({ invalid }) => {
    const { db, service } = setup();
    await expect(service.activatePolicy(actor, { rules: invalid as readonly AiBudgetRule[], changeReference: 'OPS-818' }))
      .rejects.toThrow(BadRequestException);
    expect(db.state().authority).toEqual(initial().authority);
    expect(db.state().audits).toHaveLength(0);
  });

  it('sets coverage once to locked database time while preserving a halt and all charges', async () => {
    const { db, service } = setup();
    db.replace({ ...db.state(), authority: { ...db.state().authority, coverage_start: null, halted: true } });
    const result = await service.beginCoverage(actor, { changeReference: 'OPS-818' });
    expect(result.coverageStart).toBe('2026-11-21T12:00:00.000Z');
    expect(db.state().authority).toEqual({ ...initial().authority, coverage_start: databaseNow, halted: true });
    expect(db.state().attempts).toEqual(initial().attempts);
    await expect(service.beginCoverage(actor, { changeReference: 'OPS-819' }))
      .rejects.toThrow(ConflictException);
    expect(db.state().authority.coverage_start).toEqual(databaseNow);
  });

  it('fails closed if coverage has no active policy', async () => {
    const { db, service } = setup();
    db.replace({ ...db.state(), authority: { ...db.state().authority, coverage_start: null, policy_version: null } });
    await expect(service.beginCoverage(actor, { changeReference: 'OPS-818' }))
      .rejects.toThrow(ServiceUnavailableException);
    expect(db.state().authority.coverage_start).toBeNull();
  });

  it('refuses client baseline values at the service boundary', async () => {
    const { db, service } = setup();
    await expect(service.beginCoverage(actor, {
      changeReference: 'OPS-818', coverageStart: '2000-01-01T00:00:00Z', baselineTokens: '0',
    } as any)).rejects.toThrow(BadRequestException);
    expect(db.state().audits).toHaveLength(0);
  });

  it('creates only a bounded user bonus in the locked fixed UTC admission window', async () => {
    const { db, service } = setup();
    const result = await service.createOverride(actor, {
      ...override, extraTokens: '1000000', extraSpendUsdNanos: '100000000000',
    });
    expect(db.state().overrides).toEqual([expect.objectContaining({
      id: result.id, user_id: userId, window: 'day',
      window_start: new Date('2026-11-21T00:00:00.000Z'),
      created_at: databaseNow, expires_at: new Date('2026-11-21T23:00:00.000Z'),
      extra_tokens: '1000000', extra_nanos: '100000000000', revoked_at: null,
    })]);
    expect(db.state().authority).toEqual(initial().authority);
    expect(db.state().policies).toEqual(initial().policies);
    expect(db.state().attempts).toEqual(initial().attempts);
  });

  it.each([
    { ...override, extraTokens: '1000001' },
    { ...override, extraSpendUsdNanos: '100000000001' },
    { ...override, extraTokens: '0', extraSpendUsdNanos: '0' },
    { ...override, extraTokens: '-1' },
    { ...override, extraTokens: '01' },
    { ...override, extraTokens: 1000 },
    { ...override, userId: '*' },
    { ...override, userId: 'openai' },
    { ...override, scope: 'global' },
    { ...override, bypassProvider: true },
  ])('rejects unbounded, malformed or wider-scope bonuses %j', async (input) => {
    const { db, service } = setup();
    await expect(service.createOverride(actor, input as AiBudgetOverrideInput))
      .rejects.toThrow(BadRequestException);
    expect(db.state().overrides).toHaveLength(0);
    expect(db.state().audits).toHaveLength(0);
  });

  it.each([
    '2026-11-21T12:00:00.000Z', '2026-11-20T23:00:00.000Z',
    '2026-11-22T00:00:00.001Z', '2026-11-22T12:00:00.001Z',
    '2026-02-31T15:00:00.000Z', '2026-11-21T15:00:00', '2026-11-22', 'next week',
  ])('rejects expired, over-window or invalid expiry %j', async (expiresAt) => {
    const { db, service } = setup();
    await expect(service.createOverride(actor, { ...override, expiresAt }))
      .rejects.toThrow(BadRequestException);
    expect(db.state().overrides).toHaveLength(0);
  });

  it('caps monthly bonuses at exactly 24 hours from database time', async () => {
    const { db, service } = setup();
    await expect(service.createOverride(actor, {
      ...override, window: 'month', expiresAt: '2026-11-22T12:00:00.001Z',
    })).rejects.toThrow(BadRequestException);
    await service.createOverride(actor, {
      ...override, window: 'month', expiresAt: '2026-11-22T12:00:00.000Z',
    });
    expect(db.state().overrides[0].window_start).toEqual(new Date('2026-11-01T00:00:00.000Z'));
  });

  it('permits an expiry at the window end and rejects a second active user-window bonus', async () => {
    const { db, service } = setup();
    await service.createOverride(actor, { ...override, expiresAt: '2026-11-22T00:00:00.000Z' });
    await expect(service.createOverride(actor, override)).rejects.toThrow(ConflictException);
    expect(db.state().overrides).toHaveLength(1);
  });

  it('permits a replacement after database expiry without refunding existing holds', async () => {
    const { db, service } = setup();
    await service.createOverride(actor, { ...override, expiresAt: '2026-11-21T13:00:00.000Z' });
    db.clock(new Date('2026-11-21T14:00:00.000Z'));
    await service.createOverride(actor, override);
    expect(db.state().overrides).toHaveLength(2);
    expect(db.state().attempts).toEqual(initial().attempts);
  });

  it('denies overrides while the current window precedes coverage initialization', async () => {
    const { db, service } = setup();
    db.replace({ ...db.state(), authority: { ...db.state().authority,
      coverage_start: new Date('2026-11-21T10:00:00.000Z') } });
    await expect(service.createOverride(actor, override)).rejects.toThrow(ServiceUnavailableException);
    expect(db.state().overrides).toHaveLength(0);
  });

  it('denies overrides before coverage exists', async () => {
    const { db, service } = setup();
    db.replace({ ...db.state(), authority: { ...db.state().authority, coverage_start: null } });
    await expect(service.createOverride(actor, override)).rejects.toThrow(ServiceUnavailableException);
    expect(db.state().overrides).toHaveLength(0);
  });

  it('revokes with database time, permits a new bounded bonus and preserves existing charges', async () => {
    const { db, service } = setup();
    const created = await service.createOverride(actor, override);
    const result = await service.revokeOverride(actor, created.id, { changeReference: 'OPS-819' });
    expect(result.revokedAt).toBe('2026-11-21T12:00:00.000Z');
    expect(db.state().overrides[0].revoked_at).toEqual(databaseNow);
    await service.createOverride(actor, override);
    expect(db.state().overrides).toHaveLength(2);
    expect(db.state().attempts).toEqual(initial().attempts);
  });

  it('makes repeat revocation idempotent without moving the revocation timestamp', async () => {
    const { db, service } = setup();
    const created = await service.createOverride(actor, override);
    const first = await service.revokeOverride(actor, created.id, { changeReference: 'OPS-819' });
    db.clock(new Date('2026-11-21T14:00:00.000Z'));
    const second = await service.revokeOverride(actor, created.id, { changeReference: 'OPS-820' });
    expect(second.revokedAt).toBe(first.revokedAt);
  });

  it('refuses unknown and malformed override identifiers', async () => {
    const { db, service } = setup();
    await expect(service.revokeOverride(actor, userId, { changeReference: 'OPS-819' }))
      .rejects.toThrow(NotFoundException);
    await expect(service.revokeOverride(actor, 'not-a-uuid', { changeReference: 'OPS-819' }))
      .rejects.toThrow(BadRequestException);
    expect(db.state().overrides).toHaveLength(0);
  });

  it('records only reviewed action codes, UUID links and opaque change references', async () => {
    const { db, service } = setup();
    const result = await service.createPrice(actor, price);
    expect(db.state().audits.map((row) => row.outcome)).toEqual(['attempted', 'success']);
    expect(result.auditEventId).toBe(db.state().audits[1].eventId);
    expect(db.state().audits[1]).toEqual(expect.objectContaining({
      action: AdminActionType.CONFIG_CREATE, actorId: actor.id, actorType: 'user',
      targetId: result.id, resultReference: result.id,
      targetType: 'ai_budget_price', capability: 'ai_budget.price.create:OPS-818',
      authoritySource: 'rbac', authorityReference: actor.id,
      timestamp: databaseNow, retentionUntil: new Date('2027-11-21T12:00:00.000Z'),
    }));
    expect(JSON.stringify(db.state().audits)).not.toContain('inputNanos');
    expect(JSON.stringify(db.state().audits)).not.toContain('rules');
  });

  it.each([
    { ...price, changeReference: 'free form prompt canary' },
    { ...price, changeReference: 'OPS-818\nsecret' },
    { ...price, reason: 'secret-prompt-canary' },
    { ...price, actorId: userId, role: 'admin' },
  ])('refuses unreviewed audit payloads at the service boundary', async (input) => {
    const { db, service } = setup();
    await expect(service.createPrice(actor, input as AiBudgetPriceInput))
      .rejects.toThrow(BadRequestException);
    expect(db.state().audits).toHaveLength(0);
  });

  it('keeps the same active manager and authority lock through the success audit', async () => {
    const { db, service } = setup();
    await service.createPrice(actor, price);
    const insert = db.queries().find((entry) => /INSERT INTO ai_budget_prices/i.test(entry.sql))!;
    const writes = db.queries().filter((entry) => entry.manager === insert.manager);
    const lock = writes.find((entry) => /FOR UPDATE/i.test(entry.sql))!;
    const clock = writes[writes.indexOf(lock) + 1];
    expect(clock.sql).toMatch(/clock_timestamp/i);
    expect(lock.manager).toBe(clock.manager);
    expect(writes.indexOf(clock)).toBeLessThan(writes.indexOf(insert));
    expect(db.headReads()[1]).toEqual({
      manager: insert.manager,
      options: { where: { id: 1 }, lock: { mode: 'pessimistic_write' } },
    });
    expect(db.state().audits[1].outcome).toBe('success');
  });

  it('rolls back price effects if the real execute success audit fails', async () => {
    const { db, service } = setup();
    db.failSuccessAudit();
    await expect(service.createPrice(actor, price)).rejects.toThrow('audit unavailable');
    expect(db.state().prices).toHaveLength(0);
    expect(db.state().audits.map((row) => row.outcome)).toEqual(['attempted', 'rolled_back']);
    expect(db.state().attempts).toEqual(initial().attempts);
  });

  it('rolls back revocation if its success audit is unavailable', async () => {
    const { db, service } = setup();
    const created = await service.createOverride(actor, override);
    db.failSuccessAudit();
    await expect(service.revokeOverride(actor, created.id, { changeReference: 'OPS-819' }))
      .rejects.toThrow('audit unavailable');
    expect(db.state().overrides[0].revoked_at).toBeNull();
    expect(db.state().attempts).toEqual(initial().attempts);
  });

  it('fails before effects if the durable audit attempt cannot be written', async () => {
    const { db, service } = setup();
    db.failAttemptAudit();
    await expect(service.createPrice(actor, price)).rejects.toThrow('audit unavailable');
    expect(db.state().prices).toHaveLength(0);
    expect(db.state().audits).toHaveLength(0);
  });

  it('rejects a foreign budget DataSource before administrative effects', async () => {
    const db = database();
    const config = new ConfigService({ AI_BUDGET_OPERATOR_IDS: actor.id });
    const service = new AiBudgetAdminService(
      db.source, config, new AdminAuditService(db.source, config), new AiBudgetService(database().source),
    );
    await expect(service.createPrice(actor, price)).rejects.toThrow();
    expect(db.state().prices).toHaveLength(0);
    expect(db.state().audits.map((row) => row.outcome)).toEqual(['attempted', 'rolled_back']);
  });

  it('refuses a bonus for a window without an applicable user policy rule', async () => {
    const { db, service } = setup();
    const policy = rules.filter((rule) => !(rule.scope === 'user' && rule.window === 'day'));
    await service.activatePolicy(actor, { rules: policy, changeReference: 'OPS-819' });
    await expect(service.createOverride(actor, override)).rejects.toThrow(BadRequestException);
    expect(db.state().overrides).toHaveLength(0);
  });

  it('copies validated actor and input before the first asynchronous audit boundary', async () => {
    const { db, service } = setup();
    const input = { ...price };
    const currentActor = { ...actor };
    const result = service.createPrice(currentActor, input);
    input.inputNanos = '999';
    currentActor.id = userId;
    await result;
    expect(db.state().prices[0].input_nanos).toBe('150');
    expect(db.state().prices[0].actor_id).toBe(actor.id);
  });
});

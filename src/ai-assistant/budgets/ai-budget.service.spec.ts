import { DataSource, EntityManager } from 'typeorm';
import { AiBudgetService } from './ai-budget.service';
import { AiBudgetRepository } from './ai-budget.repository';
import { AiBudgetError } from './ai-budget.errors';
import { AiBudgetRequest, AiBudgetRule } from './ai-budget.types';

jest.mock('./ai-budget.repository', () => ({ AiBudgetRepository: jest.fn() }));

const userId = '00000000-0000-4000-8000-000000000001';
const priceId = '00000000-0000-4000-8000-000000000002';
const policyId = '00000000-0000-4000-8000-000000000003';
const attemptId = '00000000-0000-4000-8000-000000000004';
const now = new Date('2026-11-21T12:00:00Z');
const request: AiBudgetRequest = {
  userId, provider: 'openai', model: 'gpt-4o-mini', operation: 'chat',
};
const policy: readonly AiBudgetRule[] = [
  ['user', '*', 'day'], ['global', '*', 'month'],
  ['provider', 'openai', 'day'], ['provider', 'anthropic', 'day'],
].map(([scope, subject, window]) => ({
  scope, subject, window, tokenLimit: '1000000', spendLimitUsdNanos: '1000000000',
} as AiBudgetRule));

function fixture() {
  const price = { id: priceId, provider: 'openai', model: 'gpt-4o-mini',
    inputNanos: '2', outputNanos: '3', cachedInputNanos: '1' };
  const attempt = {
    id: attemptId, ...request, priceId, policyId,
    maxInputTokens: '128000', maxOutputTokens: '16384',
    reservedTokens: '144384', reservedNanos: '305152',
    chargedTokens: '144384', chargedNanos: '305152',
    actualInputTokens: null, actualOutputTokens: null, state: 'held',
    outcome: null, createdAt: now, settledAt: null,
  };
  const repository = {
    getPolicy: jest.fn().mockResolvedValue(policy),
    getPrice: jest.fn().mockResolvedValue(price),
    getConsumption: jest.fn().mockResolvedValue({
      tokens: '0', spendNanos: '0', unknownRequests: 0,
    }),
    getOverride: jest.fn().mockResolvedValue({ tokens: '0', spendNanos: '0' }),
    insertAttempt: jest.fn().mockResolvedValue(undefined),
    getAttempt: jest.fn().mockResolvedValue(attempt),
    getAttemptPrice: jest.fn().mockResolvedValue(price),
    settleAttempt: jest.fn().mockResolvedValue(undefined),
    writeUsage: jest.fn().mockResolvedValue(undefined),
    getUserWindow: jest.fn(),
  };
  const source = { options: { type: 'postgres' }, isInitialized: true, transaction: jest.fn() };
  const manager = {
    connection: source,
    queryRunner: { connection: source, isTransactionActive: true, isReleased: false },
    query: jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) {
        return [{ policy_version: policyId, coverage_start: new Date('2026-10-01T00:00:00Z'), halted: false }];
      }
      if (sql.includes('clock_timestamp()')) return [{ now }];
      return [];
    }),
  };
  source.transaction.mockImplementation(async (_isolation: string, work: (tx: EntityManager) => unknown) =>
    work(manager as unknown as EntityManager));
  (AiBudgetRepository as jest.Mock).mockImplementation(() => repository);
  return { service: new AiBudgetService(source as unknown as DataSource),
    source, manager, repository, attempt, price };
}

async function errorOf(work: Promise<unknown>): Promise<AiBudgetError> {
  try { await work; } catch (error) {
    expect(error).toBeInstanceOf(AiBudgetError);
    return error as AiBudgetError;
  }
  throw new Error('Expected admission failure');
}

describe('AI budget transaction orchestration (unit contracts)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('validates a shared active manager, locks before sampling DB time, and passes camel-case authority', async () => {
    const f = fixture();
    const work = jest.fn().mockResolvedValue('ok');
    expect(await f.service.withAuthority(f.manager as unknown as EntityManager, work)).toBe('ok');
    expect(f.manager.query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(f.manager.query.mock.calls[1][0]).toContain('clock_timestamp()');
    expect(work).toHaveBeenCalledWith(now, {
      policyVersion: policyId, coverageStart: new Date('2026-10-01T00:00:00Z'), halted: false,
    });
  });

  it.each(['foreign', 'inactive', 'released', 'sqlite', 'offline'])(
    'rejects the %s manager before work', async (kind) => {
      const f = fixture();
      const candidate = {
        ...f.manager,
        connection: kind === 'foreign' ? {} : f.source,
        queryRunner: { ...f.manager.queryRunner,
          isTransactionActive: kind !== 'inactive', isReleased: kind === 'released' },
      };
      if (kind === 'sqlite') f.source.options.type = 'sqlite';
      if (kind === 'offline') f.source.isInitialized = false;
      const work = jest.fn();
      await errorOf(f.service.withAuthority(candidate as unknown as EntityManager, work));
      expect(work).not.toHaveBeenCalled();
      expect(f.manager.query).not.toHaveBeenCalled();
    });

  it('reserves full server bounds and both token and spend holds in READ COMMITTED', async () => {
    const f = fixture();
    const result = await f.service.reserve({ ...request, maxInputTokens: 1 } as AiBudgetRequest);
    expect(result.maxInputTokens).toBe(128000);
    expect(result.maxOutputTokens).toBe(16384);
    expect(result.priceVersion).toBe(priceId);
    expect(f.source.transaction).toHaveBeenCalledWith('READ COMMITTED', expect.any(Function));
    expect(AiBudgetRepository).toHaveBeenCalledWith(f.manager);
    expect(f.repository.insertAttempt).toHaveBeenCalledWith(expect.objectContaining({
      reservedTokens: '144384', reservedNanos: '305152',
      chargedTokens: '144384', chargedNanos: '305152', createdAt: now,
    }));
  });

  it('reserves Anthropic full input at the conservative cache-creation multiplier', async () => {
    const f = fixture();
    f.repository.getPrice.mockResolvedValue({
      ...f.price, provider: 'anthropic', model: 'claude-3-haiku-20240307',
    });
    await f.service.reserve({ ...request, provider: 'anthropic', model: 'claude-3-haiku-20240307' });
    expect(f.repository.insertAttempt).toHaveBeenCalledWith(expect.objectContaining({
      maxInputTokens: '200000', maxOutputTokens: '1024',
      reservedTokens: '201024', reservedNanos: '803072',
    }));
  });

  it.each(['missing-policy', 'missing-price', 'coverage-null', 'coverage-undrained', 'halted', 'legacy-unknown'])(
    'fails closed for %s without creating an attempt', async (condition) => {
      const f = fixture();
      if (condition === 'missing-policy') f.repository.getPolicy.mockResolvedValue(null);
      if (condition === 'missing-price') f.repository.getPrice.mockResolvedValue(null);
      if (condition === 'legacy-unknown') f.repository.getConsumption.mockResolvedValue({
        tokens: '0', spendNanos: '0', unknownRequests: 1,
      });
      if (['coverage-null', 'coverage-undrained', 'halted'].includes(condition)) {
        f.manager.query.mockImplementation(async (sql: string) => sql.includes('FOR UPDATE') ? [{
          policy_version: policyId,
          coverage_start: condition === 'coverage-null' ? null :
            new Date(condition === 'coverage-undrained' ? '2026-11-02T00:00:00Z' : '2026-10-01T00:00:00Z'),
          halted: condition === 'halted',
        }] : [{ now }]);
      }
      const error = await errorOf(f.service.reserve(request));
      expect(error.getStatus()).toBe(503);
      expect(f.repository.insertAttempt).not.toHaveBeenCalled();
    });

  it('reports the latest reset across token and spend blocking rules without counters', async () => {
    const f = fixture();
    f.repository.getConsumption.mockResolvedValue({
      tokens: '999999', spendNanos: '999999999', unknownRequests: 0,
    });
    const error = await errorOf(f.service.reserve(request));
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toEqual(expect.objectContaining({
      code: 'AI_BUDGET_EXHAUSTED', resetAt: '2026-12-01T00:00:00.000Z',
      retryAfterSeconds: 820800,
    }));
    expect(JSON.stringify(error.getResponse())).not.toMatch(/999999|provider|global|remaining/i);
  });

  it('distinguishes a request that can never fit an empty effective rule', async () => {
    const f = fixture();
    f.repository.getPolicy.mockResolvedValue(policy.map((item) =>
      item.scope === 'user' ? { ...item, tokenLimit: '144383' } : item));
    const error = await errorOf(f.service.reserve(request));
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toEqual(expect.objectContaining({
      code: 'AI_REQUEST_EXCEEDS_BUDGET', resetAt: null, retryAfterSeconds: null,
    }));
  });

  it('applies user overrides only to user rules; global and provider checks still block', async () => {
    const f = fixture();
    f.repository.getOverride.mockResolvedValue({ tokens: '1000000', spendNanos: '100000000000' });
    f.repository.getConsumption.mockImplementation(async (rule: AiBudgetRule) => ({
      tokens: rule.scope === 'global' ? '999999' : '0', spendNanos: '0', unknownRequests: 0,
    }));
    expect((await errorOf(f.service.reserve(request))).getStatus()).toBe(429);
    expect(f.repository.insertAttempt).not.toHaveBeenCalled();
  });

  it('settles known cached usage with the originally reserved immutable price', async () => {
    const f = fixture();
    const accounting = await f.service.reconcile(attemptId, 'success', {
      inputTokens: 20, outputTokens: 10, cachedInputTokens: 5,
    }, 17);
    expect(f.repository.getAttemptPrice).toHaveBeenCalledWith(priceId);
    expect(f.repository.getPrice).not.toHaveBeenCalled();
    expect(accounting).toEqual({
      state: 'settled', actualTokens: 30, chargedTokens: '30',
      chargedSpendUsdNanos: '65', priceVersion: priceId,
    });
    expect(f.repository.writeUsage).toHaveBeenCalledWith(
      f.attempt, expect.objectContaining({ state: 'settled', chargedNanos: '65' }), 'success', 17, now,
    );
    expect(f.repository.settleAttempt).toHaveBeenCalled();
  });

  it.each([null, { inputTokens: 1 } as any,
    { inputTokens: -1, outputTokens: 2 },
    { inputTokens: NaN, outputTokens: 1 },
    { inputTokens: 1, outputTokens: 1, cachedInputTokens: 2 }])(
    'retains the durable hold and null actuals for incomplete usage %p', async (usage) => {
      const f = fixture();
      const result = await f.service.reconcile(attemptId, 'provider_error', usage, 20);
      expect(result).toEqual({
        state: 'held', actualTokens: null, chargedTokens: '144384',
        chargedSpendUsdNanos: '305152', priceVersion: priceId,
      });
      expect(f.repository.writeUsage).toHaveBeenCalledWith(f.attempt,
        expect.objectContaining({ actualInputTokens: null, actualOutputTokens: null, state: 'held' }),
        'provider_error', 20, now);
    });

  it('records above-bound actual evidence without refund and durably halts future admission', async () => {
    const f = fixture();
    const result = await f.service.reconcile(attemptId, 'success', {
      inputTokens: 128001, outputTokens: 2,
    }, 1);
    expect(result.state).toBe('violated');
    expect(BigInt(result.chargedTokens)).toBeGreaterThanOrEqual(144384n);
    expect(BigInt(result.chargedSpendUsdNanos)).toBeGreaterThanOrEqual(305152n);
    expect(f.repository.settleAttempt).toHaveBeenCalledWith(attemptId,
      expect.objectContaining({ actualInputTokens: '128001', actualOutputTokens: '2' }), now);
    expect(f.manager.query.mock.calls.some(([sql]) => sql.includes('halted = TRUE'))).toBe(true);
  });

  it('commits a sticky halt without a partial settlement when violation usage storage fails', async () => {
    const f = fixture();
    f.repository.writeUsage.mockRejectedValue(new Error('private usage error'));
    const error = await errorOf(f.service.reconcile(attemptId, 'success',
      { inputTokens: 128001, outputTokens: 0 }, 1));
    expect(error.getStatus()).toBe(503);
    expect(f.source.transaction).toHaveBeenCalledTimes(1);
    const sql = f.manager.query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('halted = TRUE');
    expect(sql).toContain('SAVEPOINT ai_budget_settlement');
    expect(sql).toContain('ROLLBACK TO SAVEPOINT ai_budget_settlement');
    expect(sql).toContain('RELEASE SAVEPOINT ai_budget_settlement');
    expect(JSON.stringify(error.getResponse())).not.toContain('private usage error');
  });

  it('retains huge actual evidence and saturates an unrepresentable violation price product while halted', async () => {
    const f = fixture();
    f.repository.getAttemptPrice.mockResolvedValue({
      ...f.price, inputNanos: '1000000000', outputNanos: '1000000000', cachedInputNanos: '0',
    });
    const result = await f.service.reconcile(attemptId, 'success',
      { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER }, 1);
    expect(result.state).toBe('violated');
    expect(result.actualTokens).toBeNull();
    expect(result.chargedTokens).toBe('18014398509481982');
    expect(result.chargedSpendUsdNanos).toBe('9000000000000000000');
    expect(f.repository.settleAttempt).toHaveBeenCalledWith(attemptId,
      expect.objectContaining({
        actualInputTokens: '9007199254740991', actualOutputTokens: '9007199254740991',
      }), now);
  });

  it('makes repeated reconciliation idempotent, including an already finalized unknown hold', async () => {
    const f = fixture();
    f.repository.getAttempt.mockResolvedValue({ ...f.attempt, outcome: 'usage_missing' });
    const result = await f.service.reconcile(attemptId, 'success', { inputTokens: 1, outputTokens: 2 }, 1);
    expect(result.state).toBe('held');
    expect(result.actualTokens).toBeNull();
    expect(f.repository.writeUsage).not.toHaveBeenCalled();
    expect(f.repository.settleAttempt).not.toHaveBeenCalled();
  });

  it('returns only a safe unavailable error when settlement persistence fails', async () => {
    const f = fixture();
    f.repository.writeUsage.mockRejectedValue(new Error('private SQL detail'));
    const error = await errorOf(f.service.reconcile(attemptId, 'success',
      { inputTokens: 2, outputTokens: 1 }, 1));
    expect(error.getStatus()).toBe(503);
    expect(JSON.stringify(error.getResponse())).not.toContain('private SQL detail');
  });

  it('queries own day/month reports through the authenticated UUID only', async () => {
    const f = fixture();
    f.repository.getUserWindow.mockImplementation(async (id: string, window: string) => ({
      window, startAt: '2026-11-21T00:00:00Z', resetAt: '2026-12-01T00:00:00Z',
      actualTokens: '0', chargedTokens: '144384', chargedSpendUsdNanos: '305152', uncertainRequests: 1,
    }));
    const result = await f.service.getUserUsage(userId);
    expect(result.windows).toHaveLength(2);
    expect(f.repository.getUserWindow.mock.calls.map(([id, window]) => [id, window]))
      .toEqual([[userId, 'day'], [userId, 'month']]);
  });
});

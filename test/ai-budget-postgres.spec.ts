import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AiBudgetService } from '../src/ai-assistant/budgets/ai-budget.service';
import { AiBudgetError } from '../src/ai-assistant/budgets/ai-budget.errors';
import { AiBudgetRule, AiBudgetRequest } from '../src/ai-assistant/budgets/ai-budget.types';
import { AiUsageLog } from '../src/ai-assistant/entities/ai-usage-log.entity';
import { DurableAiBudgets1795300000000 } from '../src/migrations/1795300000000-DurableAiBudgets';

const url = process.env.AI_BUDGET_POSTGRES_TEST_URL;
// This opt-in suite requires a disposable PostgreSQL database. Never use DATABASE_URL.
const userId = '00000000-0000-4000-8000-000000000001';
const otherUser = '00000000-0000-4000-8000-000000000099';
const request: AiBudgetRequest = {
  userId, provider: 'openai', model: 'gpt-4o-mini', operation: 'chat',
};
const reservedTokens = '144384';
const reservedNanos = '305152';
const normalRules = (): readonly AiBudgetRule[] => [
  ['user', '*'], ['global', '*'], ['provider', 'openai'], ['provider', 'anthropic'],
].map(([scope, subject]) => ({
  scope, subject, window: 'day', tokenLimit: '1000000', spendLimitUsdNanos: '1000000000',
} as AiBudgetRule));
interface Options {
  readonly rules?: readonly AiBudgetRule[];
  readonly coverage?: 'none' | 'now';
  readonly seedPolicy?: boolean;
  readonly seedPrice?: boolean;
  readonly historical?: boolean;
}
interface Fixture {
  readonly first: DataSource;
  readonly second: DataSource;
  readonly firstBudget: AiBudgetService;
  readonly secondBudget: AiBudgetService;
  readonly schema: string;
  readonly policyId: string;
  readonly priceId: string;
  readonly legacyId: string;
  readonly legacyCreatedAt?: Date;
}
const sourceFor = (schema: string): DataSource => new DataSource({
  type: 'postgres', url, schema, entities: [AiUsageLog], synchronize: false,
  extra: { options: '-c search_path=' + schema, max: 4 },
});

async function historicalTable(source: DataSource, id: string): Promise<void> {
  await source.query(`CREATE TABLE ai_usage_logs (
    id varchar PRIMARY KEY, "userId" varchar NULL, "conversationId" varchar,
    "messageId" varchar, provider varchar NOT NULL, model varchar,
    endpoint varchar NOT NULL, status varchar NOT NULL,
    "promptTokens" integer NOT NULL DEFAULT 0,
    "completionTokens" integer NOT NULL DEFAULT 0, "totalTokens" integer NOT NULL DEFAULT 0,
    "latencyMs" integer NOT NULL DEFAULT 0, "cacheHit" boolean NOT NULL DEFAULT FALSE,
    "errorCode" varchar, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp())`);
  await source.query(`INSERT INTO ai_usage_logs
    (id,"userId",provider,model,endpoint,status,"promptTokens","completionTokens","totalTokens")
    VALUES ($1,NULL,'openai','gpt-4o-mini','chat','error',90,5,95)`, [id]);
}

async function seed(f: Fixture, options: Options): Promise<void> {
  await f.first.transaction('READ COMMITTED', (manager) =>
    f.firstBudget.withAuthority(manager, async (now) => {
      if (options.seedPolicy !== false) {
        await manager.query(`INSERT INTO ai_budget_policies
          (id,rules,actor_id,change_reference) VALUES ($1,$2::jsonb,$3,'OPS-818')`,
        [f.policyId, JSON.stringify(options.rules ?? normalRules()), userId]);
      }
      if (options.seedPrice !== false) {
        await manager.query(`INSERT INTO ai_budget_prices
          (id,provider,model,input_nanos,output_nanos,cached_input_nanos,actor_id,change_reference)
          VALUES ($1,'openai','gpt-4o-mini',2,3,1,$2,'OPS-818')`, [f.priceId, userId]);
      }
      const drained = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      await manager.query(`UPDATE ai_budget_authority SET policy_version=$1, coverage_start=$2 WHERE id=1`,
        [options.seedPolicy === false ? null : f.policyId,
          options.coverage === 'none' ? null : options.coverage === 'now' ? now : drained]);
    }));
}

async function withFixture(work: (f: Fixture) => Promise<void>, options: Options = {}): Promise<void> {
  const schema = 'budget_test_' + randomUUID().replaceAll('-', '');
  const first = sourceFor(schema);
  const second = sourceFor(schema);
  const f: Fixture = {
    first, second, schema, firstBudget: new AiBudgetService(first),
    secondBudget: new AiBudgetService(second),
    policyId: randomUUID(), priceId: randomUUID(), legacyId: randomUUID(),
  };
  try {
    await first.initialize();
    await first.query('CREATE SCHEMA "' + schema + '"');
    if (options.historical) await historicalTable(first, f.legacyId);
    const historicalRows = options.historical ? await first.query(
      'SELECT "createdAt" FROM ai_usage_logs WHERE id=$1', [f.legacyId]) : [];
    await first.transaction(async (manager) =>
      new DurableAiBudgets1795300000000().up(manager.queryRunner!));
    await second.initialize();
    await seed(f, options);
    await work({ ...f, legacyCreatedAt: historicalRows[0]?.createdAt });
  } finally {
    if (second.isInitialized) await second.destroy();
    if (first.isInitialized) {
      await first.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
      await first.destroy();
    }
  }
}

async function denied(promise: Promise<unknown>, code: string): Promise<void> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(AiBudgetError);
    expect((error as AiBudgetError).getResponse()).toEqual(expect.objectContaining({ code }));
    return;
  }
  throw new Error('Expected budget denial');
}
const counts = (source: DataSource) => source.query(
  'SELECT id,state,charged_tokens::text,charged_nanos::text FROM ai_budget_attempts');

(url ? describe : describe.skip)('durable AI budget PostgreSQL concurrency and restart', () => {
  it.each(['user', 'provider', 'global'] as const)(
    'serializes independent DataSources at the %s ceiling', async (scope) => {
      const rules = normalRules().map((rule) => rule.scope === scope
        ? { ...rule, tokenLimit: reservedTokens } : rule);
      await withFixture(async (f) => {
        const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
          (index % 2 ? f.firstBudget : f.secondBudget).reserve({
            ...request, userId: scope === 'user' ? userId : index % 2 ? userId : otherUser,
          })));
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
        expect(rejected).toHaveLength(7);
        rejected.forEach((result) => {
          expect(result.reason).toBeInstanceOf(AiBudgetError);
          expect(result.reason.getStatus()).toBe(429);
        });
        const attempts = await counts(f.first);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toEqual(expect.objectContaining({
          state: 'held', charged_tokens: reservedTokens, charged_nanos: reservedNanos,
        }));
      }, { rules });
    }, 30000);

  it('blocks concurrent admissions on spend even when token quota remains', async () => {
    await withFixture(async (f) => {
      const results = await Promise.allSettled([
        f.firstBudget.reserve(request), f.secondBudget.reserve({ ...request, userId: otherUser }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await counts(f.second)).toHaveLength(1);
    }, { rules: normalRules().map((rule) => rule.scope === 'global'
      ? { ...rule, spendLimitUsdNanos: reservedNanos } : rule) });
  }, 30000);

  it('retains unresolved reservations across fresh DataSources and exposes them in own reports', async () => {
    await withFixture(async (f) => {
      const reservation = await f.firstBudget.reserve(request);
      const restartedSource = sourceFor(f.schema);
      try {
        await restartedSource.initialize();
        const restarted = new AiBudgetService(restartedSource);
        const report = await restarted.getUserUsage(userId);
        report.windows.forEach((window) => {
          expect(window.actualTokens).toBe('0');
          expect(window.chargedTokens).toBe(reservedTokens);
          expect(window.chargedSpendUsdNanos).toBe(reservedNanos);
          expect(window.uncertainRequests).toBe(1);
        });
        await denied(restarted.reserve(request), 'AI_BUDGET_EXHAUSTED');
        expect((await counts(restartedSource))[0].id).toBe(reservation.id);
        expect((await restarted.getUserUsage(otherUser)).windows[0].chargedTokens).toBe('0');
      } finally {
        if (restartedSource.isInitialized) await restartedSource.destroy();
      }
    }, { rules: normalRules().map((rule) => ({ ...rule, tokenLimit: reservedTokens })) });
  }, 30000);

  it('settles once, atomically records usage, and retains the original price revision after a price change', async () => {
    await withFixture(async (f) => {
      const reservation = await f.firstBudget.reserve(request);
      await f.first.query(`INSERT INTO ai_budget_prices
        (id,provider,model,input_nanos,output_nanos,cached_input_nanos,actor_id,change_reference)
        VALUES ($1,'openai','gpt-4o-mini',200,300,100,$2,'OPS-819')`, [randomUUID(), userId]);
      const [result, duplicate] = await Promise.all([
        f.secondBudget.reconcile(reservation.id, 'success',
          { inputTokens: 20, outputTokens: 10, cachedInputTokens: 5 }, 10),
        f.firstBudget.reconcile(reservation.id, 'success',
          { inputTokens: 20, outputTokens: 10, cachedInputTokens: 5 }, 10),
      ]);
      expect(duplicate).toEqual(result);
      expect(result).toEqual({
        state: 'settled', actualTokens: 30, chargedTokens: '30',
        chargedSpendUsdNanos: '65', priceVersion: f.priceId,
      });
      expect(await f.firstBudget.reconcile(reservation.id, 'success',
        { inputTokens: 100, outputTokens: 100 }, 5)).toEqual(result);
      const logs = await f.first.query('SELECT * FROM ai_usage_logs WHERE "budgetAttemptId"=$1',
        [reservation.id]);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toEqual(expect.objectContaining({
        priceVersion: f.priceId, chargedTokens: '30', costUsdNanos: '65',
        promptTokens: '20', completionTokens: '10', totalTokens: '30', usageComplete: true,
      }));
      expect((await f.secondBudget.getUserUsage(userId)).windows[0].chargedSpendUsdNanos).toBe('65');
    });
  }, 30000);

  it('keeps full unknown holds for provider errors, null actual fields and duplicate reconciliation', async () => {
    await withFixture(async (f) => {
      const reservation = await f.firstBudget.reserve(request);
      const result = await f.secondBudget.reconcile(reservation.id, 'provider_error', null, 10);
      expect(result.state).toBe('held');
      expect(result.actualTokens).toBeNull();
      expect(result.chargedSpendUsdNanos).toBe(reservedNanos);
      expect(await f.firstBudget.reconcile(reservation.id, 'usage_missing', null, 10)).toEqual(result);
      const logs = await f.first.query('SELECT * FROM ai_usage_logs WHERE "budgetAttemptId"=$1',
        [reservation.id]);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toEqual(expect.objectContaining({
        promptTokens: null, completionTokens: null, totalTokens: null,
        usageComplete: false, chargedTokens: reservedTokens, costUsdNanos: reservedNanos,
      }));
    });
  }, 30000);

  it('rolls back settlement and its log together when the usage insert fails', async () => {
    await withFixture(async (f) => {
      const reservation = await f.firstBudget.reserve(request);
      await f.first.query(`CREATE FUNCTION reject_budget_usage() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'usage storage unavailable'; END; $$ LANGUAGE plpgsql`);
      await f.first.query(`CREATE TRIGGER reject_budget_usage BEFORE INSERT ON ai_usage_logs
        FOR EACH ROW EXECUTE FUNCTION reject_budget_usage()`);
      await denied(f.secondBudget.reconcile(reservation.id, 'success',
        { inputTokens: 1, outputTokens: 1 }, 1), 'AI_BUDGET_UNAVAILABLE');
      expect((await counts(f.first))[0]).toEqual(expect.objectContaining({
        state: 'held', charged_tokens: reservedTokens, charged_nanos: reservedNanos,
      }));
      expect(await f.first.query('SELECT * FROM ai_usage_logs')).toHaveLength(0);
      expect((await f.firstBudget.getUserUsage(userId)).windows[0].uncertainRequests).toBe(1);
      await f.first.query('DROP TRIGGER reject_budget_usage ON ai_usage_logs');
      await f.first.query('DROP FUNCTION reject_budget_usage()');
      expect((await f.firstBudget.reconcile(reservation.id, 'success',
        { inputTokens: 1, outputTokens: 1 }, 1)).state).toBe('settled');
    });
  }, 30000);

  it('commits the violation halt while a failed usage insert leaves the original full hold intact', async () => {
    await withFixture(async (f) => {
      const reservation = await f.firstBudget.reserve(request);
      await f.first.query(`CREATE FUNCTION reject_violation_usage() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'usage storage unavailable'; END; $$ LANGUAGE plpgsql`);
      await f.first.query(`CREATE TRIGGER reject_violation_usage BEFORE INSERT ON ai_usage_logs
        FOR EACH ROW EXECUTE FUNCTION reject_violation_usage()`);
      await denied(f.secondBudget.reconcile(reservation.id, 'success',
        { inputTokens: 128001, outputTokens: 0 }, 1), 'AI_BUDGET_UNAVAILABLE');
      expect((await counts(f.first))[0]).toEqual(expect.objectContaining({
        state: 'held', charged_tokens: reservedTokens, charged_nanos: reservedNanos,
      }));
      expect(await f.first.query('SELECT * FROM ai_usage_logs')).toHaveLength(0);
      expect((await f.first.query('SELECT halted FROM ai_budget_authority'))[0].halted).toBe(true);
      await denied(f.firstBudget.reserve(request), 'AI_BUDGET_USAGE_BOUND_VIOLATED');
    });
  }, 30000);

  it('preserves an acknowledged-lost committed hold and prevents a restart from resetting it', async () => {
    await withFixture(async (f) => {
      const runner = f.first.createQueryRunner();
      const actualCommit = runner.commitTransaction.bind(runner);
      jest.spyOn(runner, 'commitTransaction').mockImplementationOnce(async () => {
        await actualCommit();
        throw new Error('lost commit acknowledgement');
      });
      const create = jest.spyOn(f.first, 'createQueryRunner').mockReturnValueOnce(runner);
      try {
        await denied(f.firstBudget.reserve(request), 'AI_BUDGET_UNAVAILABLE');
      } finally { create.mockRestore(); }
      expect(await counts(f.second)).toHaveLength(1);
      await denied(f.secondBudget.reserve(request), 'AI_BUDGET_EXHAUSTED');
      expect((await f.secondBudget.getUserUsage(userId)).windows[0].uncertainRequests).toBe(1);
    }, { rules: normalRules().map((rule) => ({ ...rule, tokenLimit: reservedTokens })) });
  }, 30000);

  it.each([
    [{ seedPolicy: false }, 'AI_BUDGET_POLICY_MISSING'],
    [{ seedPrice: false }, 'AI_BUDGET_PRICE_MISSING'],
    [{ coverage: 'none' }, 'AI_BUDGET_ACCOUNTING_NOT_READY'],
    [{ coverage: 'now' }, 'AI_BUDGET_ACCOUNTING_NOT_READY'],
  ] as const)('refuses missing or undrained configuration %p', async (options, code) => {
    await withFixture(async (f) => {
      await denied(f.firstBudget.reserve(request), code);
      expect(await counts(f.first)).toHaveLength(0);
    }, options);
  }, 30000);

  it('preserves populated historical usage, never invents price/cost, and counts unattributed unknown paid usage', async () => {
    await withFixture(async (f) => {
      const [legacy] = await f.first.query('SELECT * FROM ai_usage_logs WHERE id=$1', [f.legacyId]);
      expect(legacy).toEqual(expect.objectContaining({
        id: f.legacyId, userId: null, promptTokens: '90', completionTokens: '5',
        totalTokens: '95', budgetAttemptId: null, priceVersion: null,
        chargedTokens: null, costUsdNanos: null, usageComplete: false,
      }));
      expect(legacy.createdAt.toISOString()).toBe(f.legacyCreatedAt!.toISOString());
      await denied(f.secondBudget.reserve(request), 'AI_BUDGET_USAGE_UNPRICED');
      expect(await counts(f.first)).toHaveLength(0);
    }, { historical: true });
  }, 30000);

  it('continues counting admissions across policy revisions and prices', async () => {
    await withFixture(async (f) => {
      await f.firstBudget.reserve(request);
      const nextPolicy = randomUUID();
      await f.first.transaction('READ COMMITTED', (manager) =>
        f.firstBudget.withAuthority(manager, async () => {
          await manager.query(`INSERT INTO ai_budget_policies
            (id,rules,actor_id,change_reference) VALUES ($1,$2::jsonb,$3,'OPS-819')`,
          [nextPolicy, JSON.stringify(normalRules().map((rule) => ({
            ...rule, tokenLimit: reservedTokens,
          }))), userId]);
          await manager.query('UPDATE ai_budget_authority SET policy_version=$1 WHERE id=1', [nextPolicy]);
        }));
      await denied(f.secondBudget.reserve(request), 'AI_BUDGET_EXHAUSTED');
      expect(await counts(f.first)).toHaveLength(1);
    });
  }, 30000);

  it('retains violation evidence above int32, keeps at least the hold and halts every replica', async () => {
    await withFixture(async (f) => {
      const reservation = await f.firstBudget.reserve(request);
      const result = await f.secondBudget.reconcile(reservation.id, 'success',
        { inputTokens: 3000000000, outputTokens: 1 }, 1);
      expect(result.state).toBe('violated');
      expect(result.actualTokens).toBe(3000000001);
      expect(BigInt(result.chargedSpendUsdNanos)).toBeGreaterThanOrEqual(BigInt(reservedNanos));
      const [attempt] = await f.first.query('SELECT * FROM ai_budget_attempts WHERE id=$1',
        [reservation.id]);
      expect(attempt.actual_input_tokens).toBe('3000000000');
      expect((await f.first.query('SELECT halted FROM ai_budget_authority'))[0].halted).toBe(true);
      await denied(f.firstBudget.reserve(request), 'AI_BUDGET_USAGE_BOUND_VIOLATED');
      await expect(f.first.query('UPDATE ai_budget_authority SET halted=FALSE WHERE id=1'))
        .rejects.toThrow();
    });
  }, 30000);

  it('allows user-only bonuses without bypassing provider/global ceilings on new admission', async () => {
    await withFixture(async (f) => {
      const reservation = await f.firstBudget.reserve(request);
      await f.first.transaction('READ COMMITTED', (manager) =>
        f.firstBudget.withAuthority(manager, async (now) => {
          const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
          const end = new Date(start.getTime() + 86400000);
          const expiry = new Date(Math.min(now.getTime() + 60000, end.getTime()));
          await manager.query(`INSERT INTO ai_budget_overrides
            (id,user_id,"window",window_start,extra_tokens,extra_nanos,expires_at,created_at,actor_id,change_reference)
            VALUES ($1,$2,'day',$3,$4,0,$5,$6,$2,'OPS-818')`,
          [randomUUID(), userId, start, reservedTokens, expiry, now]);
        }));
      await denied(f.secondBudget.reserve(request), 'AI_BUDGET_EXHAUSTED');
      expect((await counts(f.first))[0].id).toBe(reservation.id);
    }, { rules: normalRules().map((rule) => ({
      ...rule, tokenLimit: rule.scope === 'provider' ? reservedTokens : '1000000',
    })) });
  }, 30000);

  it('allows a bounded user bonus and preserves previous charges after revocation', async () => {
    await withFixture(async (f) => {
      await f.firstBudget.reserve(request);
      const id = randomUUID();
      await f.first.transaction('READ COMMITTED', (manager) =>
        f.firstBudget.withAuthority(manager, async (now) => {
          const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
          const end = new Date(start.getTime() + 86400000);
          await manager.query(`INSERT INTO ai_budget_overrides
            (id,user_id,"window",window_start,extra_tokens,extra_nanos,expires_at,created_at,actor_id,change_reference)
            VALUES ($1,$2,'day',$3,$4,0,$5,$6,$2,'OPS-818')`,
          [id, userId, start, reservedTokens, end, now]);
        }));
      await f.secondBudget.reserve(request);
      await f.second.transaction('READ COMMITTED', (manager) =>
        f.secondBudget.withAuthority(manager, async (now) => {
          await manager.query('UPDATE ai_budget_overrides SET revoked_at=$2 WHERE id=$1', [id, now]);
        }));
      await denied(f.firstBudget.reserve(request), 'AI_BUDGET_EXHAUSTED');
      expect(await counts(f.first)).toHaveLength(2);
      expect((await f.secondBudget.getUserUsage(userId)).windows[0].chargedTokens).toBe('288768');
    }, { rules: normalRules().map((rule) => rule.scope === 'user'
      ? { ...rule, tokenLimit: reservedTokens } : rule) });
  }, 30000);

  it('ignores expired user overrides for new admissions without erasing their evidence', async () => {
    await withFixture(async (f) => {
      await f.firstBudget.reserve(request);
      const id = randomUUID();
      await f.first.transaction('READ COMMITTED', (manager) =>
        f.firstBudget.withAuthority(manager, async (now) => {
          const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
          await manager.query(`INSERT INTO ai_budget_overrides
            (id,user_id,"window",window_start,extra_tokens,extra_nanos,expires_at,created_at,actor_id,change_reference)
            VALUES ($1,$2,'day',$3,$4,0,$5,$6,$2,'OPS-818')`,
          [id, userId, start, reservedTokens, new Date(now.getTime()-1000), new Date(now.getTime()-2000)]);
        }));
      await denied(f.secondBudget.reserve(request), 'AI_BUDGET_EXHAUSTED');
      expect(await f.first.query('SELECT id FROM ai_budget_overrides WHERE id=$1', [id])).toHaveLength(1);
      expect(await counts(f.first)).toHaveLength(1);
    }, { rules: normalRules().map((rule) => rule.scope === 'user'
      ? { ...rule, tokenLimit: reservedTokens } : rule) });
  }, 30000);

  it('enforces price/policy/ledger immutability and refuses populated destructive rollback', async () => {
    await withFixture(async (f) => {
      const reservation = await f.firstBudget.reserve(request);
      for (const table of ['ai_budget_prices', 'ai_budget_policies']) {
        await expect(f.first.query('DELETE FROM ' + table)).rejects.toThrow('append-only');
        await expect(f.first.query('TRUNCATE ' + table + ' CASCADE')).rejects.toThrow();
      }
      await expect(f.first.query('UPDATE ai_budget_prices SET input_nanos=4 WHERE id=$1', [f.priceId]))
        .rejects.toThrow('append-only');
      await expect(f.first.query('UPDATE ai_budget_attempts SET reserved_tokens=1 WHERE id=$1',
        [reservation.id])).rejects.toThrow();
      await expect(f.first.transaction((manager) =>
        new DurableAiBudgets1795300000000().down(manager.queryRunner!)))
        .rejects.toThrow('Refusing to remove populated AI budget evidence');
      expect(await counts(f.second)).toHaveLength(1);
    });
  }, 30000);

  it('round-trips an unused migration without dropping preserved historical usage', async () => {
    await withFixture(async (f) => {
      await f.first.transaction((manager) =>
        new DurableAiBudgets1795300000000().down(manager.queryRunner!));
      const [preserved] = await f.first.query('SELECT * FROM ai_usage_logs');
      expect(preserved).toEqual(expect.objectContaining({ id: f.legacyId, totalTokens: '95' }));
      expect(preserved.createdAt.toISOString()).toBe(f.legacyCreatedAt!.toISOString());
      await f.first.transaction((manager) =>
        new DurableAiBudgets1795300000000().up(manager.queryRunner!));
      const [authority] = await f.second.query('SELECT * FROM ai_budget_authority');
      expect(authority.coverage_start).toBeNull();
      expect(authority.policy_version).toBeNull();
    }, { seedPolicy: false, seedPrice: false, coverage: 'none', historical: true });
  }, 30000);
});

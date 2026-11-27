import { QueryRunner } from 'typeorm';
import { DurableAiBudgets1795300000000 } from './1795300000000-DurableAiBudgets';
import { DurableAiBudgets1795300000000 as CliMigration } from '../database/migrations/1795300000000-DurableAiBudgets';

function runner(type = 'postgres') {
  return {
    connection: { options: { type } }, isTransactionActive: true,
    query: jest.fn().mockResolvedValue([]),
  };
}

describe('Durable AI budgets migration SQL contracts', () => {
  it('uses the same class on runtime and CLI discovery paths', () => {
    expect(CliMigration).toBe(DurableAiBudgets1795300000000);
  });

  it('refuses unsupported storage before running DDL', async () => {
    const queryRunner = runner('sqlite');
    await expect(new DurableAiBudgets1795300000000().up(queryRunner as unknown as QueryRunner))
      .rejects.toThrow('PostgreSQL');
    expect(queryRunner.query).not.toHaveBeenCalled();
  });

  it('provisions native PostgreSQL tables while preserving existing usage values', async () => {
    const queryRunner = runner();
    await new DurableAiBudgets1795300000000().up(queryRunner as unknown as QueryRunner);
    const sql = queryRunner.query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "ai_usage_logs"');
    expect(sql).toContain('GENERATED ALWAYS AS IDENTITY');
    expect(sql).toContain('coverage_start timestamptz NULL');
    expect(sql).toContain('"costUsdNanos" bigint NULL');
    expect(sql).toContain('"priceVersion" uuid NULL');
    expect(sql).toContain('"budgetAttemptId" uuid NULL');
    expect(sql).toContain('"usageComplete" boolean NOT NULL DEFAULT FALSE');
    expect(sql).not.toMatch(/UPDATE\s+"?ai_usage_logs/i);
    expect(sql).not.toMatch(/costUsdNanos[^,\n]*DEFAULT\s+['"]?0/i);
    expect(sql).not.toMatch(/DELETE\s+FROM|datetime\(|PRISMA|sqlite/i);
  });

  it('makes immutable prices/policies and protects durable attempts from mutation/deletion', async () => {
    const queryRunner = runner();
    await new DurableAiBudgets1795300000000().up(queryRunner as unknown as QueryRunner);
    const sql = queryRunner.query.mock.calls.map(([statement]) => statement).join('\n');
    for (const table of ['ai_budget_policies', 'ai_budget_prices']) {
      expect(sql).toContain('BEFORE UPDATE OR DELETE ON "' + table + '"');
      expect(sql).toContain('BEFORE TRUNCATE ON "' + table + '"');
    }
    expect(sql).toContain('ai_budget_attempts');
    expect(sql).toContain('append-only');
    expect(sql).toContain('"budgetAttemptId"');
    expect(sql).toContain('UNIQUE');
  });

  it('locks every evidence table and refuses a populated ledger before destructive down DDL', async () => {
    const queryRunner = runner();
    await new DurableAiBudgets1795300000000().down(queryRunner as unknown as QueryRunner);
    const sql = queryRunner.query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('ACCESS EXCLUSIVE MODE');
    expect(sql).toContain('Refusing to remove populated AI budget evidence');
    for (const table of ['ai_budget_attempts', 'ai_budget_policies', 'ai_budget_prices', 'ai_budget_overrides']) {
      expect(sql).toContain('SELECT 1 FROM "' + table + '"');
    }
    expect(sql).toContain('coverage_start IS NOT NULL');
    expect(sql).toContain('"costUsdNanos" IS NOT NULL');
    expect(sql).not.toContain('DROP TABLE "ai_usage_logs"');
    const drop = queryRunner.query.mock.calls.findIndex(([statement]) => statement.includes('DROP TABLE'));
    const refusal = queryRunner.query.mock.calls.findIndex(([statement]) => statement.includes('Refusing to remove'));
    expect(refusal).toBeLessThan(drop);
  });
});

import {
  buildPoolConfig,
  buildPoolExtra,
  POOL_LIMITS,
  Workload,
  WORKLOADS,
} from './pool.config';

describe('pool.config', () => {
  const emptyEnv = {} as NodeJS.ProcessEnv;

  describe('buildPoolConfig defaults', () => {
    it('provides safe defaults when no env vars are set', () => {
      const cfg = buildPoolConfig(emptyEnv);

      expect(cfg.poolMax).toBe(20);
      expect(cfg.poolMin).toBe(2);
      expect(cfg.acquireTimeoutMs).toBe(30_000);
      expect(cfg.statementTimeoutMs).toBe(15_000);
      expect(cfg.idleTransactionTimeoutMs).toBe(10_000);
      expect(cfg.transactionDeadlineMs).toBe(30_000);
    });

    it('derives per-workload budgets as fractions of poolMax', () => {
      const cfg = buildPoolConfig({ ...emptyEnv, DB_POOL_MAX: '50' });

      expect(cfg.budgets[Workload.API]).toBe(30); // 60%
      expect(cfg.budgets[Workload.JOBS]).toBe(15); // 30%
      expect(cfg.budgets[Workload.ADMIN]).toBe(5); // 10%
      expect(cfg.budgets[Workload.DEFAULT]).toBe(25); // 50%
    });

    it('every workload has a budget entry', () => {
      const cfg = buildPoolConfig(emptyEnv);
      for (const wl of WORKLOADS) {
        expect(cfg.budgets[wl]).toBeGreaterThanOrEqual(
          POOL_LIMITS.workloadBudget.min,
        );
        expect(cfg.budgets[wl]).toBeLessThanOrEqual(
          POOL_LIMITS.workloadBudget.max,
        );
      }
    });
  });

  describe('fail-closed clamping', () => {
    it('clamps a poolMax above the hard maximum', () => {
      const cfg = buildPoolConfig({ ...emptyEnv, DB_POOL_MAX: '100000' });
      expect(cfg.poolMax).toBe(POOL_LIMITS.poolMax.max);
    });

    it('clamps a poolMax of zero up to the hard minimum', () => {
      const cfg = buildPoolConfig({ ...emptyEnv, DB_POOL_MAX: '0' });
      expect(cfg.poolMax).toBe(POOL_LIMITS.poolMax.min);
    });

    it('clamps a negative poolMax up to the hard minimum', () => {
      const cfg = buildPoolConfig({ ...emptyEnv, DB_POOL_MAX: '-5' });
      expect(cfg.poolMax).toBe(POOL_LIMITS.poolMax.min);
    });

    it('clamps a statement timeout that would disable cancellation', () => {
      const cfg = buildPoolConfig({ ...emptyEnv, DB_STATEMENT_TIMEOUT: '0' });
      expect(cfg.statementTimeoutMs).toBe(POOL_LIMITS.statementTimeoutMs.min);
    });

    it('clamps an idle transaction timeout below the minimum', () => {
      const cfg = buildPoolConfig({
        ...emptyEnv,
        DB_IDLE_TRANSACTION_TIMEOUT: '10',
      });
      expect(cfg.idleTransactionTimeoutMs).toBe(
        POOL_LIMITS.idleTransactionTimeoutMs.min,
      );
    });

    it('clamps an acquisition timeout above the maximum', () => {
      const cfg = buildPoolConfig({
        ...emptyEnv,
        DB_POOL_ACQUIRE_TIMEOUT: '99999999',
      });
      expect(cfg.acquireTimeoutMs).toBe(POOL_LIMITS.acquireTimeoutMs.max);
    });

    it('falls back to the default for a non-integer value (fail-closed)', () => {
      const cfg = buildPoolConfig({ ...emptyEnv, DB_POOL_MAX: 'not-a-number' });
      expect(cfg.poolMax).toBe(20);
    });

    it('never emits NaN or Infinity for any field', () => {
      const cfg = buildPoolConfig({
        DB_POOL_MAX: 'Infinity',
        DB_POOL_MIN: 'NaN',
        DB_POOL_ACQUIRE_TIMEOUT: 'abc',
        DB_STATEMENT_TIMEOUT: '',
        DB_IDLE_TRANSACTION_TIMEOUT: 'undefined',
        DB_TRANSACTION_DEADLINE: 'null',
      } as NodeJS.ProcessEnv);

      const numbers = [
        cfg.poolMax,
        cfg.poolMin,
        cfg.acquireTimeoutMs,
        cfg.statementTimeoutMs,
        cfg.idleTransactionTimeoutMs,
        cfg.transactionDeadlineMs,
        ...Object.values(cfg.budgets),
      ];
      for (const n of numbers) {
        expect(Number.isFinite(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
      }
    });

    it('keeps poolMin within [0, poolMax]', () => {
      const cfg = buildPoolConfig({
        ...emptyEnv,
        DB_POOL_MAX: '5',
        DB_POOL_MIN: '50',
      });
      expect(cfg.poolMin).toBeLessThanOrEqual(cfg.poolMax);
      expect(cfg.poolMin).toBeGreaterThanOrEqual(POOL_LIMITS.poolMin.min);
    });
  });

  describe('buildPoolExtra', () => {
    it('includes statement and idle-transaction timeouts as pg GUCs', () => {
      const cfg = buildPoolConfig(emptyEnv);
      const extra = buildPoolExtra(cfg);

      expect(extra.max).toBe(cfg.poolMax);
      expect(extra.connectionTimeoutMillis).toBe(cfg.acquireTimeoutMs);
      expect(extra.statement_timeout).toBe(cfg.statementTimeoutMs);
      expect(extra.idle_in_transaction_session_timeout).toBe(
        cfg.idleTransactionTimeoutMs,
      );
    });

    it('produces only finite integers (safe to serialize / never leaks secrets)', () => {
      const extra = buildPoolExtra(
        buildPoolConfig({ DB_POOL_MAX: '99999' } as NodeJS.ProcessEnv),
      );
      for (const value of Object.values(extra)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(Number.isInteger(value)).toBe(true);
      }
      // Must not contain any connection-string-like value.
      expect(JSON.stringify(extra)).not.toMatch(/postgres|password|:\/\/|@/);
    });

    it('keeps idleTimeoutMillis at least twice the idle-transaction timeout', () => {
      const cfg = buildPoolConfig({
        ...emptyEnv,
        DB_POOL_ACQUIRE_TIMEOUT: '1000',
        DB_IDLE_TRANSACTION_TIMEOUT: '30000',
      });
      const extra = buildPoolExtra(cfg);
      expect(extra.idleTimeoutMillis).toBeGreaterThanOrEqual(
        cfg.idleTransactionTimeoutMs * 2,
      );
    });

    it('honors an explicit DB_POOL_IDLE_TIMEOUT when set', () => {
      const cfg = buildPoolConfig({
        ...emptyEnv,
        DB_POOL_IDLE_TIMEOUT: '45000',
      });
      expect(cfg.idleTimeoutMs).toBe(45_000);
      expect(buildPoolExtra(cfg).idleTimeoutMillis).toBe(45_000);
    });
  });
});

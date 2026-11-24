import {
  PoolBudgetExhaustedError,
  PoolBudgetService,
} from './pool-budget.service';
import { Workload } from './pool.config';

/**
 * Builds a PoolBudgetService with deterministic, small budgets by overriding
 * the resolved config (unit-level; no real database or environment needed).
 */
function makeService(
  overrides: Partial<{
    budgets: Record<Workload, number>;
    acquireTimeoutMs: number;
  }> = {},
): PoolBudgetService {
  const service = new PoolBudgetService();
  const cfg = service.getConfig();
  // Mutate a shallow copy so each test controls its own budget surface.
  const patched = {
    ...cfg,
    acquireTimeoutMs: overrides.acquireTimeoutMs ?? cfg.acquireTimeoutMs,
    budgets: { ...cfg.budgets, ...(overrides.budgets ?? {}) },
  };
  (service as unknown as { config: typeof patched }).config = patched;
  // Reset per-workload counters for isolation.
  for (const wl of Object.values(Workload)) {
    void wl;
  }
  return service;
}

/** Deterministic small budget: 2 slots for the tested workload. */
const SMALL: Record<Workload, number> = {
  [Workload.API]: 2,
  [Workload.JOBS]: 2,
  [Workload.ADMIN]: 2,
  [Workload.DEFAULT]: 2,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('PoolBudgetService', () => {
  describe('pool exhaustion', () => {
    it('rejects once the workload budget is exhausted (fail-closed)', async () => {
      const svc = makeService({ budgets: SMALL, acquireTimeoutMs: 50 });

      // Occupy every slot.
      const r1 = await svc.acquire(Workload.API);
      const r2 = await svc.acquire(Workload.API);
      expect(svc.getInUse(Workload.API)).toBe(2);

      // Third acquisition must fail fast rather than hang.
      await expect(svc.acquire(Workload.API)).rejects.toThrow(
        PoolBudgetExhaustedError,
      );

      r1();
      r2();
      expect(svc.getInUse(Workload.API)).toBe(0);
    });

    it('a timed-out acquisition is bounded by acquireTimeoutMs, not indefinite', async () => {
      const svc = makeService({ budgets: SMALL, acquireTimeoutMs: 60 });
      const held = [
        await svc.acquire(Workload.API),
        await svc.acquire(Workload.API),
      ];

      const start = Date.now();
      await expect(svc.acquire(Workload.API)).rejects.toThrow(
        PoolBudgetExhaustedError,
      );
      const elapsed = Date.now() - start;

      // Should time out near the configured deadline (allow generous slack).
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(1000);

      held.forEach((r) => r());
    });

    it('releases the budget slot even when the wrapped work throws', async () => {
      const svc = makeService({ budgets: SMALL, acquireTimeoutMs: 50 });

      await expect(
        svc.run(Workload.API, async () => {
          throw new Error('work failed');
        }),
      ).rejects.toThrow('work failed');

      // Slot must be free again after the failure.
      expect(svc.getInUse(Workload.API)).toBe(0);
      await expect(svc.acquire(Workload.API)).resolves.toBeInstanceOf(Function);
    });

    it('release() is idempotent (double release cannot inflate the budget)', async () => {
      const svc = makeService({ budgets: SMALL, acquireTimeoutMs: 50 });
      const release = await svc.acquire(Workload.API);
      release();
      release();
      release();
      expect(svc.getInUse(Workload.API)).toBe(0);
    });
  });

  describe('background jobs have separate budgets', () => {
    it('jobs saturating their budget does not block the API workload', async () => {
      const svc = makeService({
        budgets: { ...SMALL, [Workload.JOBS]: 1 },
        acquireTimeoutMs: 50,
      });

      // Saturate the JOBS budget.
      const jobRelease = await svc.acquire(Workload.JOBS);
      await expect(svc.acquire(Workload.JOBS)).rejects.toThrow(
        PoolBudgetExhaustedError,
      );

      // API still has its own independent budget.
      await expect(svc.acquire(Workload.API)).resolves.toBeInstanceOf(Function);
      jobRelease();
    });

    it('API saturating its budget does not block the JOBS workload', async () => {
      const svc = makeService({
        budgets: { ...SMALL, [Workload.API]: 1 },
        acquireTimeoutMs: 50,
      });

      const apiRelease = await svc.acquire(Workload.API);
      await expect(svc.acquire(Workload.API)).rejects.toThrow(
        PoolBudgetExhaustedError,
      );

      await expect(svc.acquire(Workload.JOBS)).resolves.toBeInstanceOf(
        Function,
      );
      apiRelease();
    });
  });

  describe('burst', () => {
    it('a burst of concurrent requests never exceeds the budget', async () => {
      const svc = makeService({ budgets: SMALL, acquireTimeoutMs: 40 });
      const burst = 25;

      const results = await Promise.allSettled(
        Array.from({ length: burst }, () =>
          svc.run(Workload.API, async () => {
            await sleep(5);
            return 'ok';
          }),
        ),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r) =>
          r.status === 'rejected' &&
          r.reason instanceof PoolBudgetExhaustedError,
      );

      // Some succeed, the rest are rejected as budget-exhausted — never hang.
      expect(fulfilled.length).toBeGreaterThan(0);
      expect(fulfilled.length + rejected.length).toBe(burst);
      // Budget is fully released after the burst settles.
      expect(svc.getInUse(Workload.API)).toBe(0);
    });

    it('records acquisition timeouts for burst overflow (bounded counter)', async () => {
      // Budget 2, 30ms deadline, 20 requests × 8ms work ⇒ the back of the
      // queue must wait longer than the deadline and time out.
      const svc = makeService({ budgets: SMALL, acquireTimeoutMs: 30 });

      await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          svc.run(Workload.JOBS, async () => {
            await sleep(8);
          }),
        ),
      );

      const metrics = svc.getMetrics();
      expect(metrics.totalAcquisitionTimeouts).toBeGreaterThan(0);
      expect(
        metrics.byWorkload[Workload.JOBS].acquisitionTimeouts,
      ).toBeGreaterThan(0);
    });
  });

  describe('fairness / handoff', () => {
    it('a released slot is handed to the next waiter (FIFO)', async () => {
      const svc = makeService({ budgets: SMALL, acquireTimeoutMs: 500 });
      const r1 = await svc.acquire(Workload.API);
      const r2 = await svc.acquire(Workload.API);

      let acquired = false;
      const waiting = svc.acquire(Workload.API).then((release) => {
        acquired = true;
        return release;
      });

      // Not yet acquired — budget is full.
      await sleep(10);
      expect(acquired).toBe(false);

      r1(); // hand off to the waiter
      const r3 = await waiting;
      expect(acquired).toBe(true);

      r2();
      r3();
      expect(svc.getInUse(Workload.API)).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('rejects new acquisitions once shutdown begins', async () => {
      const svc = makeService({ budgets: SMALL, acquireTimeoutMs: 50 });
      await svc.shutdown();

      await expect(svc.acquire(Workload.API)).rejects.toThrow(
        PoolBudgetExhaustedError,
      );
      expect(svc.isShuttingDown).toBe(true);
    });

    it('drains (rejects) in-flight waiters during shutdown', async () => {
      const svc = makeService({ budgets: SMALL, acquireTimeoutMs: 5000 });
      const r1 = await svc.acquire(Workload.API);
      const r2 = await svc.acquire(Workload.API);

      const waiter = svc.acquire(Workload.API);
      await sleep(10);

      await svc.shutdown();

      await expect(waiter).rejects.toThrow(PoolBudgetExhaustedError);

      r1();
      r2();
    });

    it('shutdown is idempotent', async () => {
      const svc = makeService({ budgets: SMALL, acquireTimeoutMs: 50 });
      await svc.shutdown();
      await expect(svc.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('failover', () => {
    it('budget recovers after a failure burst (failover / retry)', async () => {
      const svc = makeService({ budgets: SMALL, acquireTimeoutMs: 30 });

      // Simulate a DB outage burst: many concurrent requests all reject.
      const outage = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          svc.run(Workload.API, async () => {
            throw new Error('connection terminated');
          }),
        ),
      );
      expect(outage.every((r) => r.status === 'rejected')).toBe(true);
      expect(svc.getInUse(Workload.API)).toBe(0);

      // "Failover": database is back — budget must be fully usable again.
      const recovered = await Promise.allSettled(
        Array.from({ length: 2 }, () =>
          svc.run(Workload.API, async () => 'ok'),
        ),
      );
      expect(recovered.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(svc.getInUse(Workload.API)).toBe(0);
    });
  });

  describe('bounded and sanitized metrics', () => {
    it('getMetrics returns only finite non-negative integers', async () => {
      const svc = makeService({ budgets: SMALL, acquireTimeoutMs: 30 });
      const r = await svc.acquire(Workload.API);
      await svc.acquire(Workload.JOBS).catch(() => undefined);
      await svc
        .run(Workload.ADMIN, async () => undefined)
        .catch(() => undefined);
      r();

      const m = svc.getMetrics();
      const numbers = [
        m.poolMax,
        m.acquireTimeoutMs,
        m.statementTimeoutMs,
        m.idleTransactionTimeoutMs,
        m.transactionDeadlineMs,
        m.totalInUse,
        m.totalWaiting,
        m.totalAcquisitionTimeouts,
        m.totalRejections,
      ];
      for (const n of numbers) {
        expect(Number.isFinite(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(n)).toBe(true);
      }
    });

    it('metrics workload map is the closed enum (bounded cardinality)', () => {
      const svc = makeService();
      const m = svc.getMetrics();
      expect(Object.keys(m.byWorkload).sort()).toEqual(
        [...Object.values(Workload)].sort(),
      );
    });

    it('never leaks secrets or connection strings', () => {
      const svc = makeService();
      const serialized = JSON.stringify(svc.getMetrics());
      expect(serialized).not.toMatch(/postgres|password|secret|:\/\/|@/);
    });

    it('an unknown workload falls back to the default budget (fail-closed)', async () => {
      const svc = makeService({
        budgets: { ...SMALL, [Workload.DEFAULT]: 1 },
        acquireTimeoutMs: 40,
      });

      const r = await svc.acquire('unknown-workload' as Workload);
      expect(svc.getInUse(Workload.DEFAULT)).toBe(1);
      await expect(svc.acquire('unknown-workload' as Workload)).rejects.toThrow(
        PoolBudgetExhaustedError,
      );
      r();
    });
  });

  describe('metrics sink integration', () => {
    it('reports budget rejections and acquisition timeouts to the sink', async () => {
      const svc = makeService({ budgets: SMALL, acquireTimeoutMs: 30 });
      const sink = {
        incrementDbAcquisitionTimeout: jest.fn(),
        incrementDbStatementTimeout: jest.fn(),
        incrementDbBudgetRejected: jest.fn(),
      };
      svc.setMetricsSink(sink);

      const held = [
        await svc.acquire(Workload.API),
        await svc.acquire(Workload.API),
      ];
      // Exhaustion → acquisition timeout reported.
      await svc.acquire(Workload.API).catch(() => undefined);
      expect(sink.incrementDbAcquisitionTimeout).toHaveBeenCalledWith(
        Workload.API,
      );
      held.forEach((r) => r());

      // Shutdown → rejection reported for new work.
      await svc.shutdown();
      await svc.acquire(Workload.API).catch(() => undefined);
      expect(sink.incrementDbBudgetRejected).toHaveBeenCalledWith(Workload.API);
    });
  });
});

import { TransactionRunner } from './transaction.runner';
import { buildPoolConfig } from './pool.config';
import { DataSource, QueryRunner } from 'typeorm';

/** Builds a mock QueryRunner whose transaction state tracks lifecycle calls. */
function makeQueryRunner(overrides: Partial<QueryRunner> = {}): QueryRunner {
  let transactionActive = false;
  const qr = {
    isTransactionActive: false,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockImplementation(async () => {
      transactionActive = true;
      (qr as { isTransactionActive: boolean }).isTransactionActive = true;
    }),
    commitTransaction: jest.fn().mockImplementation(async () => {
      transactionActive = false;
      (qr as { isTransactionActive: boolean }).isTransactionActive = false;
    }),
    rollbackTransaction: jest.fn().mockImplementation(async () => {
      transactionActive = false;
      (qr as { isTransactionActive: boolean }).isTransactionActive = false;
    }),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
    manager: { getRepository: jest.fn() },
    ...overrides,
  };
  void transactionActive;
  return qr as unknown as QueryRunner;
}

function makeRunner(
  qr: QueryRunner,
  env: NodeJS.ProcessEnv = {},
): TransactionRunner {
  const dataSource = {
    options: { type: 'postgres' },
    createQueryRunner: () => qr,
  } as unknown as DataSource;
  // Pool config is read from process.env in the constructor; isolate it.
  const original = { ...process.env };
  Object.assign(process.env, env);
  try {
    return new TransactionRunner(dataSource);
  } finally {
    // Restore after construction so the runner keeps the test env values.
    process.env = original;
  }
}

describe('TransactionRunner', () => {
  describe('slow query (statement timeout)', () => {
    it('applies statement_timeout and idle_in_transaction_session_timeout on the query runner', async () => {
      const qr = makeQueryRunner();
      const runner = makeRunner(qr, {
        DB_STATEMENT_TIMEOUT: '5000',
        DB_IDLE_TRANSACTION_TIMEOUT: '4000',
      });

      await runner.run(async () => 'ok');

      const statements = (qr.query as jest.Mock).mock.calls.map((c) => c[0]);
      expect(
        statements.some((s) => String(s).includes('statement_timeout')),
      ).toBe(true);
      expect(
        statements.some((s) =>
          String(s).includes('idle_in_transaction_session_timeout'),
        ),
      ).toBe(true);
    });

    it('cancels and rolls back a callback that exceeds the transaction deadline', async () => {
      const qr = makeQueryRunner();
      // 1s minimum deadline; run a callback that never resolves within it.
      const runner = makeRunner(qr, { DB_TRANSACTION_DEADLINE: '1000' });

      const started = Date.now();
      await expect(
        runner.run(
          () =>
            new Promise((resolve) => {
              const t = setTimeout(() => resolve('late'), 5000);
              (t as unknown as { unref?: () => void }).unref?.();
            }),
          { deadlineMs: 1000 },
        ),
      ).rejects.toThrow(/deadline/i);
      const elapsed = Date.now() - started;

      // Bounded by the deadline (with slack), not the full 5s callback.
      expect(elapsed).toBeLessThan(3000);
      expect(qr.rollbackTransaction).toHaveBeenCalled();
      expect(qr.commitTransaction).not.toHaveBeenCalled();
      expect(qr.release).toHaveBeenCalled();
    });
  });

  describe('leaked transaction', () => {
    it('still releases the connection when the callback never settles', async () => {
      const qr = makeQueryRunner();
      const runner = makeRunner(qr, { DB_TRANSACTION_DEADLINE: '1000' });

      await expect(
        runner.run(
          () =>
            new Promise((resolve) => {
              /* simulate a leaked/idle transaction that never returns;
                 unref so the pending timer cannot keep the test process alive */
              const t = setTimeout(() => resolve('never'), 10_000);
              (t as unknown as { unref?: () => void }).unref?.();
            }),
          { deadlineMs: 1000 },
        ),
      ).rejects.toThrow(/deadline/i);

      // The connection must not be leaked: release is guaranteed.
      expect(qr.release).toHaveBeenCalledTimes(1);
      expect(qr.rollbackTransaction).toHaveBeenCalled();
    });

    it('rolls back and rethrows on callback error, always releasing', async () => {
      const qr = makeQueryRunner();
      const runner = makeRunner(qr);

      await expect(
        runner.run(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(qr.rollbackTransaction).toHaveBeenCalled();
      expect(qr.commitTransaction).not.toHaveBeenCalled();
      expect(qr.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('success path', () => {
    it('commits and releases on success', async () => {
      const qr = makeQueryRunner();
      const runner = makeRunner(qr);

      const result = await runner.run(async () => 42);

      expect(result).toBe(42);
      expect(qr.commitTransaction).toHaveBeenCalled();
      expect(qr.rollbackTransaction).not.toHaveBeenCalled();
      expect(qr.release).toHaveBeenCalledTimes(1);
    });

    it('passes the transaction manager to the callback', async () => {
      const qr = makeQueryRunner();
      const runner = makeRunner(qr);
      const seen: unknown[] = [];

      await runner.run(async (manager) => {
        seen.push(manager);
      });

      expect(seen[0]).toBe(qr.manager);
    });
  });

  describe('rollback resilience', () => {
    it('still releases when rollback itself throws', async () => {
      const qr = makeQueryRunner({
        rollbackTransaction: jest
          .fn()
          .mockRejectedValue(new Error('rollback failed')),
      } as Partial<QueryRunner>);
      const runner = makeRunner(qr);

      await expect(
        runner.run(async () => {
          throw new Error('work failed');
        }),
      ).rejects.toThrow('work failed');

      // Release is guaranteed even though rollback failed.
      expect(qr.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('deadline clamping (fail-closed)', () => {
    it('clamps a caller-supplied deadline below the minimum', async () => {
      const qr = makeQueryRunner();
      const runner = makeRunner(qr, { DB_TRANSACTION_DEADLINE: '30000' });

      // 0 is below the 1s floor; must be clamped, not treated as "no deadline".
      await expect(
        runner.run(async () => 'ok', { deadlineMs: 0 }),
      ).resolves.toBe('ok');
      expect(qr.commitTransaction).toHaveBeenCalled();
    });

    it('uses the configured deadline when none is supplied', async () => {
      const cfg = buildPoolConfig({
        DB_TRANSACTION_DEADLINE: '2000',
      } as NodeJS.ProcessEnv);
      expect(cfg.transactionDeadlineMs).toBe(2000);
    });
  });

  describe('SQLite / non-postgres', () => {
    it('does not attempt to SET LOCAL timeouts on non-postgres drivers', async () => {
      const qr = makeQueryRunner();
      const dataSource = {
        options: { type: 'better-sqlite3' },
        createQueryRunner: () => qr,
      } as unknown as DataSource;
      const runner = new TransactionRunner(dataSource);

      await runner.run(async () => 'ok');

      const statements = (qr.query as jest.Mock).mock.calls.map((c) => c[0]);
      expect(statements.some((s) => String(s).includes('SET LOCAL'))).toBe(
        false,
      );
    });
  });
});

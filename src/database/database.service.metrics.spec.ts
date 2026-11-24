import { DatabaseService } from './database.service';
import { DataSource } from 'typeorm';
import { buildPoolConfig } from './pool.config';

function makeService(pool: unknown): DatabaseService {
  const dataSource = {
    options: { type: 'postgres' },
    driver: { master: pool },
    query: jest.fn(),
    isInitialized: true,
    runMigrations: jest.fn(),
    migrations: [],
  } as unknown as DataSource;
  return new DatabaseService(dataSource);
}

describe('DatabaseService.getBoundedPoolMetrics', () => {
  it('returns clamped, finite values from a healthy pool', () => {
    const svc = makeService({
      totalCount: 10,
      idleCount: 4,
      waitingCount: 2,
    });
    const m = svc.getBoundedPoolMetrics();

    expect(m.available).toBe(true);
    expect(m.total).toBe(10);
    expect(m.idle).toBe(4);
    expect(m.active).toBe(6);
    expect(m.waiting).toBe(2);
    expect(m.max).toBe(buildPoolConfig(process.env).poolMax);
  });

  it('clamps negative values to zero (fail-closed)', () => {
    const svc = makeService({
      totalCount: -5,
      idleCount: -1,
      waitingCount: -3,
    });
    const m = svc.getBoundedPoolMetrics();

    expect(m.total).toBe(0);
    expect(m.idle).toBe(0);
    expect(m.active).toBe(0);
    expect(m.waiting).toBe(0);
  });

  it('clamps values above the configured pool max', () => {
    const cfg = buildPoolConfig(process.env);
    const svc = makeService({
      totalCount: 1_000_000,
      idleCount: 999_999,
      waitingCount: 123_456,
    });
    const m = svc.getBoundedPoolMetrics();

    expect(m.total).toBeLessThanOrEqual(cfg.poolMax);
    expect(m.idle).toBeLessThanOrEqual(cfg.poolMax);
    expect(m.active).toBeLessThanOrEqual(cfg.poolMax);
    expect(m.waiting).toBeLessThanOrEqual(cfg.poolMax);
  });

  it('never emits NaN or Infinity for malformed driver readings', () => {
    const svc = makeService({
      totalCount: NaN,
      idleCount: Infinity,
      waitingCount: undefined,
    });
    const m = svc.getBoundedPoolMetrics();

    for (const n of [m.total, m.idle, m.active, m.waiting, m.max]) {
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
  });

  it('fails closed when the driver exposes no pool (e.g. SQLite)', () => {
    const svc = makeService(undefined);
    const m = svc.getBoundedPoolMetrics();

    expect(m.available).toBe(false);
    expect(m.total).toBe(0);
    expect(m.waiting).toBe(0);
  });

  it('never leaks connection strings or credentials', () => {
    const svc = makeService({
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
      // A hostile/malformed pool object must not leak arbitrary fields.
      connectionString: 'postgresql://user:secret@host:5432/db',
    });
    const serialized = JSON.stringify(svc.getBoundedPoolMetrics());

    expect(serialized).not.toMatch(/secret|password|postgres|:\/\/|@/);
  });

  it('active is derived and clamped independently (never negative)', () => {
    const svc = makeService({ totalCount: 2, idleCount: 5 });
    const m = svc.getBoundedPoolMetrics();
    // totalCount - idleCount would be negative; must clamp to 0.
    expect(m.active).toBe(0);
  });
});

/**
 * DependencyGuardService unit tests
 *
 * Covers:
 *  - Pre-registration of canonical dependencies at construction time
 *  - guard() succeeds when the dependency is healthy
 *  - guard() applies the per-dependency default timeout
 *  - guard() opens the circuit after repeated failures
 *  - guard() throws CircuitOpenError (never null) when open
 *  - guard() honours explicit timeoutMs=0 (no timeout)
 *  - guard() honours explicit timeoutMs override
 *  - status() returns a snapshot per registered dependency
 *  - snapshot() returns a single circuit snapshot
 *  - reset() closes an open circuit
 *  - register() is idempotent
 *  - auto-registration of unknown dependencies
 *  - ConfigService env-var overrides for threshold and resetMs
 *  - Regression: no fabricated/null return on open circuit
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  DependencyGuardService,
  CircuitOpenError,
  DependencyTimeoutError,
} from './dependency-guard.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const succeed = () => Promise.resolve('ok');
const fail = (msg = 'boom') => () => Promise.reject(new Error(msg));
const slow = (ms: number) =>
  () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), ms));

async function makeGuard(
  configValues: Record<string, string> = {},
): Promise<DependencyGuardService> {
  const configGet = jest.fn((key: string) => configValues[key] ?? undefined);
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      DependencyGuardService,
      { provide: ConfigService, useValue: { get: configGet } },
    ],
  }).compile();
  return module.get(DependencyGuardService);
}

// ---------------------------------------------------------------------------
// Suite 1 – Construction and registration
// ---------------------------------------------------------------------------

describe('DependencyGuardService — construction', () => {
  it('constructs without errors and registers canonical dependencies', async () => {
    const svc = await makeGuard();
    const statuses = svc.status();
    const names = statuses.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(['database', 'redis', 'rpc', 'ipfs', 'queue']),
    );
  });

  it('all pre-registered circuits start in CLOSED state', async () => {
    const svc = await makeGuard();
    for (const snap of svc.status()) {
      expect(snap.state).toBe('CLOSED');
    }
  });

  it('register() is idempotent — re-registering an existing name does not throw', async () => {
    const svc = await makeGuard();
    expect(() => svc.register('database')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite 2 – guard() success path
// ---------------------------------------------------------------------------

describe('DependencyGuardService — guard() success path', () => {
  it('returns the function result on success', async () => {
    const svc = await makeGuard();
    const result = await svc.guard('database', succeed);
    expect(result).toBe('ok');
  });

  it('circuit remains CLOSED after successful calls', async () => {
    const svc = await makeGuard();
    for (let i = 0; i < 10; i++) {
      await svc.guard('redis', succeed);
    }
    expect(svc.snapshot('redis').state).toBe('CLOSED');
  });
});

// ---------------------------------------------------------------------------
// Suite 3 – guard() failure / circuit opening
// ---------------------------------------------------------------------------

describe('DependencyGuardService — guard() failure and circuit opening', () => {
  it('propagates the original error on single failure (circuit still CLOSED)', async () => {
    const svc = await makeGuard();
    await expect(svc.guard('database', fail('pg down'))).rejects.toThrow(
      'pg down',
    );
    expect(svc.snapshot('database').state).toBe('CLOSED');
  });

  it('opens the circuit after failureThreshold consecutive failures', async () => {
    // Override threshold to 3 for a faster test.
    const svc = await makeGuard({ CB_FAILURE_THRESHOLD_DATABASE: '3' });
    for (let i = 0; i < 3; i++) {
      await svc.guard('database', fail('pg error')).catch(() => {});
    }
    expect(svc.snapshot('database').state).toBe('OPEN');
  });

  it('throws CircuitOpenError (not the original error) when circuit is OPEN', async () => {
    const svc = await makeGuard({ CB_FAILURE_THRESHOLD_DATABASE: '1' });
    await svc.guard('database', fail()).catch(() => {});
    const err = await svc.guard('database', succeed).catch((e) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 – Timeout enforcement
// ---------------------------------------------------------------------------

describe('DependencyGuardService — timeout enforcement', () => {
  it('throws DependencyTimeoutError when call exceeds explicit timeoutMs', async () => {
    const svc = await makeGuard();
    await expect(
      svc.guard('redis', slow(300), 50),
    ).rejects.toBeInstanceOf(DependencyTimeoutError);
  });

  it('timeoutMs=0 disables the timeout budget entirely', async () => {
    const svc = await makeGuard();
    // slow(50) but no timeout → should resolve.
    const result = await svc.guard('redis', slow(50), 0);
    expect(result).toBe('late');
  });

  it('respects env-var override DEPENDENCY_TIMEOUT_<NAME>', async () => {
    // Override redis timeout to 30ms.
    const svc = await makeGuard({ DEPENDENCY_TIMEOUT_REDIS: '30' });
    await expect(
      svc.guard('redis', slow(300)),
    ).rejects.toBeInstanceOf(DependencyTimeoutError);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 – status() and snapshot()
// ---------------------------------------------------------------------------

describe('DependencyGuardService — status() and snapshot()', () => {
  it('status() returns one entry per registered circuit', async () => {
    const svc = await makeGuard();
    const statuses = svc.status();
    // At minimum the 5 canonical deps.
    expect(statuses.length).toBeGreaterThanOrEqual(5);
  });

  it('snapshot(name) returns the circuit state for the given dependency', async () => {
    const svc = await makeGuard();
    const snap = svc.snapshot('rpc');
    expect(snap.name).toBe('rpc');
    expect(snap.state).toBe('CLOSED');
  });

  it('snapshot() throws for an unregistered dependency', async () => {
    const svc = await makeGuard();
    expect(() => svc.snapshot('nonexistent')).toThrow(/No circuit registered/i);
  });

  it('status() totalFailures increments correctly across calls', async () => {
    const svc = await makeGuard({ CB_FAILURE_THRESHOLD_RPC: '99' });
    await svc.guard('rpc', fail()).catch(() => {});
    await svc.guard('rpc', fail()).catch(() => {});
    expect(svc.snapshot('rpc').totalFailures).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Suite 6 – reset()
// ---------------------------------------------------------------------------

describe('DependencyGuardService — reset()', () => {
  it('reset() closes an open circuit', async () => {
    const svc = await makeGuard({ CB_FAILURE_THRESHOLD_QUEUE: '1' });
    await svc.guard('queue', fail()).catch(() => {});
    expect(svc.snapshot('queue').state).toBe('OPEN');
    svc.reset('queue');
    expect(svc.snapshot('queue').state).toBe('CLOSED');
  });

  it('guard() succeeds after manual reset', async () => {
    const svc = await makeGuard({ CB_FAILURE_THRESHOLD_QUEUE: '1' });
    await svc.guard('queue', fail()).catch(() => {});
    svc.reset('queue');
    await expect(svc.guard('queue', succeed)).resolves.toBe('ok');
  });

  it('reset() on unknown dependency does not throw', async () => {
    const svc = await makeGuard();
    expect(() => svc.reset('unknown_dep')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite 7 – Auto-registration
// ---------------------------------------------------------------------------

describe('DependencyGuardService — auto-registration', () => {
  it('auto-registers an unknown dependency and starts it in CLOSED state', async () => {
    const svc = await makeGuard();
    // 'storage' is not in the canonical list.
    const result = await svc.guard('storage', succeed);
    expect(result).toBe('ok');
    expect(svc.snapshot('storage').state).toBe('CLOSED');
  });
});

// ---------------------------------------------------------------------------
// Suite 8 – Boundary and degraded-dependency scenarios
// ---------------------------------------------------------------------------

describe('DependencyGuardService — boundary conditions', () => {
  it('handles concurrent guard() calls without data races', async () => {
    const svc = await makeGuard({ CB_FAILURE_THRESHOLD_DATABASE: '99' });
    const calls = Array.from({ length: 20 }, () =>
      svc.guard('database', succeed),
    );
    const results = await Promise.all(calls);
    expect(results.every((r) => r === 'ok')).toBe(true);
  });

  it('open circuit on database does not affect other circuits', async () => {
    const svc = await makeGuard({ CB_FAILURE_THRESHOLD_DATABASE: '1' });
    await svc.guard('database', fail()).catch(() => {});
    // redis is unaffected.
    await expect(svc.guard('redis', succeed)).resolves.toBe('ok');
    expect(svc.snapshot('database').state).toBe('OPEN');
    expect(svc.snapshot('redis').state).toBe('CLOSED');
  });

  it('does not return null or undefined when circuit is OPEN — always throws', async () => {
    const svc = await makeGuard({ CB_FAILURE_THRESHOLD_RPC: '1' });
    await svc.guard('rpc', fail()).catch(() => {});

    let returnedValue: unknown = '__not_set__';
    try {
      returnedValue = await svc.guard('rpc', succeed);
    } catch {
      // expected
    }
    expect(returnedValue).toBe('__not_set__');
  });
});

// ---------------------------------------------------------------------------
// Suite 9 – Regression: fail-closed invariants
// ---------------------------------------------------------------------------

describe('DependencyGuardService — regression: fail-closed', () => {
  it('never fabricates a successful response when the dependency is unreachable', async () => {
    const svc = await makeGuard({ CB_FAILURE_THRESHOLD_IPFS: '1' });
    await svc.guard('ipfs', fail('gateway timeout')).catch(() => {});
    const err = await svc.guard('ipfs', succeed).catch((e) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
  });

  it('CircuitOpenError carries the dependency name in its message', async () => {
    const svc = await makeGuard({ CB_FAILURE_THRESHOLD_IPFS: '1' });
    await svc.guard('ipfs', fail()).catch(() => {});
    const err = await svc.guard('ipfs', succeed).catch((e) => e);
    expect(err.message).toMatch(/ipfs/i);
  });

  it('DependencyTimeoutError does not swallow the timeout context', async () => {
    const svc = await makeGuard();
    const err = await svc.guard('rpc', slow(300), 50).catch((e) => e);
    expect(err).toBeInstanceOf(DependencyTimeoutError);
    expect(err.message).toMatch(/rpc/i);
  });

  it('a successful call after circuit reset increments totalCalls correctly', async () => {
    const svc = await makeGuard({ CB_FAILURE_THRESHOLD_DATABASE: '1' });
    await svc.guard('database', fail()).catch(() => {});
    svc.reset('database');
    await svc.guard('database', succeed);
    // 2 total calls: 1 failed + 1 succeeded.
    expect(svc.snapshot('database').totalCalls).toBe(2);
  });
});

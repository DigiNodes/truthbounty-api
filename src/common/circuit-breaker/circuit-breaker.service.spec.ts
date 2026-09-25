/**
 * CircuitBreaker + withTimeout unit tests
 *
 * Covers:
 *  - CLOSED → OPEN transition at threshold
 *  - OPEN → HALF_OPEN after reset window
 *  - HALF_OPEN → CLOSED on probe success
 *  - HALF_OPEN → OPEN on probe failure
 *  - DependencyTimeoutError on timeout budget exceeded
 *  - CircuitOpenError when OPEN
 *  - Manual reset()
 *  - Snapshot accuracy
 *  - onStateChange / onCall hooks
 *  - withTimeout standalone behaviour
 *  - Fail-closed invariants (no silent null returns)
 */

import {
  CircuitBreaker,
  CircuitOpenError,
  DependencyTimeoutError,
  withTimeout,
} from './circuit-breaker.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCb(
  opts: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {},
) {
  return new CircuitBreaker({
    name: 'test',
    failureThreshold: 3,
    successThreshold: 2,
    resetMs: 1_000,
    ...opts,
  });
}

const fail = () => Promise.reject(new Error('dependency down'));
const succeed = () => Promise.resolve('ok');
const slow = (ms: number) =>
  new Promise<string>((resolve) => setTimeout(() => resolve('late'), ms));

// ---------------------------------------------------------------------------
// Suite 1 – State transitions (CLOSED / OPEN / HALF_OPEN)
// ---------------------------------------------------------------------------

describe('CircuitBreaker — state transitions', () => {
  it('starts in CLOSED state', () => {
    expect(makeCb().currentState).toBe('CLOSED');
  });

  it('remains CLOSED while failures are below threshold', async () => {
    const cb = makeCb({ failureThreshold: 3 });
    for (let i = 0; i < 2; i++) {
      try { await cb.call(fail); } catch { /* expected */ }
    }
    expect(cb.currentState).toBe('CLOSED');
  });

  it('transitions CLOSED → OPEN once failures reach threshold', async () => {
    const cb = makeCb({ failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      try { await cb.call(fail); } catch { /* expected */ }
    }
    expect(cb.currentState).toBe('OPEN');
  });

  it('throws CircuitOpenError immediately when OPEN', async () => {
    const cb = makeCb({ failureThreshold: 1 });
    try { await cb.call(fail); } catch { /* open the circuit */ }
    await expect(cb.call(succeed)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('transitions OPEN → HALF_OPEN after resetMs', async () => {
    const cb = makeCb({ failureThreshold: 1, resetMs: 10 });
    try { await cb.call(fail); } catch { /* open */ }
    expect(cb.currentState).toBe('OPEN');
    await new Promise((r) => setTimeout(r, 20));
    // Trigger the time check by attempting a call.
    await cb.call(succeed).catch(() => {});
    expect(cb.currentState).toBe('CLOSED'); // probe succeeded → CLOSED
  });

  it('transitions HALF_OPEN → CLOSED after successThreshold successful probes', async () => {
    const cb = makeCb({ failureThreshold: 1, resetMs: 5, successThreshold: 2 });
    try { await cb.call(fail); } catch { /* open */ }
    await new Promise((r) => setTimeout(r, 10));
    // First probe — HALF_OPEN, successes = 1
    await cb.call(succeed);
    expect(cb.currentState).toBe('HALF_OPEN');
    // Second probe — successes = 2 → CLOSED
    await cb.call(succeed);
    expect(cb.currentState).toBe('CLOSED');
  });

  it('transitions HALF_OPEN → OPEN when the probe fails', async () => {
    const cb = makeCb({
      failureThreshold: 1,
      successThreshold: 2,
      resetMs: 5,
    });
    try { await cb.call(fail); } catch { /* open */ }
    await new Promise((r) => setTimeout(r, 10));
    // Probe fails → back to OPEN
    try { await cb.call(fail); } catch { /* expected */ }
    expect(cb.currentState).toBe('OPEN');
  });

  it('resets consecutive failure counter on a successful call', async () => {
    const cb = makeCb({ failureThreshold: 3 });
    try { await cb.call(fail); } catch { /* 1 */ }
    try { await cb.call(fail); } catch { /* 2 */ }
    await cb.call(succeed); // resets failures to 0
    try { await cb.call(fail); } catch { /* 1 again */ }
    // Still only 1 consecutive failure — still CLOSED
    expect(cb.currentState).toBe('CLOSED');
  });

  it('manual reset() returns circuit to CLOSED regardless of current state', async () => {
    const cb = makeCb({ failureThreshold: 1 });
    try { await cb.call(fail); } catch { /* open */ }
    expect(cb.currentState).toBe('OPEN');
    cb.reset();
    expect(cb.currentState).toBe('CLOSED');
  });
});

// ---------------------------------------------------------------------------
// Suite 2 – Timeout integration
// ---------------------------------------------------------------------------

describe('CircuitBreaker — timeout enforcement', () => {
  it('throws DependencyTimeoutError when the call exceeds the budget', async () => {
    const cb = makeCb();
    await expect(
      cb.call(() => slow(200), 50),
    ).rejects.toBeInstanceOf(DependencyTimeoutError);
  });

  it('counts a timeout as a failure toward the threshold', async () => {
    const cb = makeCb({ failureThreshold: 2 });
    try { await cb.call(() => slow(200), 50); } catch { /* 1 */ }
    try { await cb.call(() => slow(200), 50); } catch { /* 2 */ }
    expect(cb.currentState).toBe('OPEN');
  });

  it('resolves normally when the call completes within the budget', async () => {
    const cb = makeCb();
    const result = await cb.call(() => succeed(), 500);
    expect(result).toBe('ok');
    expect(cb.currentState).toBe('CLOSED');
  });

  it('DependencyTimeoutError message includes the dependency name and timeout', async () => {
    const cb = new CircuitBreaker({
      name: 'redis',
      failureThreshold: 5,
    });
    const err = await cb.call(() => slow(200), 50).catch((e) => e);
    expect(err).toBeInstanceOf(DependencyTimeoutError);
    expect(err.message).toMatch(/redis/i);
    expect(err.message).toMatch(/50ms/);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 – Snapshot accuracy
// ---------------------------------------------------------------------------

describe('CircuitBreaker — snapshot()', () => {
  it('snapshot reflects zero counters on a fresh instance', () => {
    const snap = makeCb({ name: 'snap-test' }).snapshot();
    expect(snap).toMatchObject({
      name: 'snap-test',
      state: 'CLOSED',
      failures: 0,
      successes: 0,
      totalCalls: 0,
      totalFailures: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      openedAt: null,
      nextRetryAt: null,
    });
  });

  it('snapshot.totalCalls increments on every call', async () => {
    const cb = makeCb();
    await cb.call(succeed);
    try { await cb.call(fail); } catch { /* expected */ }
    expect(cb.snapshot().totalCalls).toBe(2);
  });

  it('snapshot.totalFailures only counts failures', async () => {
    const cb = makeCb();
    await cb.call(succeed);
    try { await cb.call(fail); } catch { /* expected */ }
    try { await cb.call(fail); } catch { /* expected */ }
    expect(cb.snapshot().totalFailures).toBe(2);
  });

  it('snapshot.openedAt is set when circuit opens', async () => {
    const cb = makeCb({ failureThreshold: 1 });
    const before = Date.now();
    try { await cb.call(fail); } catch { /* expected */ }
    const snap = cb.snapshot();
    expect(snap.openedAt).not.toBeNull();
    expect(snap.openedAt!).toBeGreaterThanOrEqual(before);
    expect(snap.nextRetryAt).toBe(snap.openedAt! + 1_000);
  });

  it('snapshot.lastSuccessAt and lastFailureAt are updated correctly', async () => {
    const cb = makeCb();
    await cb.call(succeed);
    const afterSuccess = cb.snapshot().lastSuccessAt;
    expect(afterSuccess).not.toBeNull();

    try { await cb.call(fail); } catch { /* expected */ }
    const afterFail = cb.snapshot().lastFailureAt;
    expect(afterFail).not.toBeNull();
    expect(afterFail!).toBeGreaterThanOrEqual(afterSuccess!);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 – Hooks (onStateChange / onCall)
// ---------------------------------------------------------------------------

describe('CircuitBreaker — hooks', () => {
  it('onStateChange is invoked with correct from/to when opening', async () => {
    const onChange = jest.fn();
    const cb = makeCb({ failureThreshold: 1, onStateChange: onChange });
    try { await cb.call(fail); } catch { /* expected */ }
    expect(onChange).toHaveBeenCalledWith('test', 'CLOSED', 'OPEN');
  });

  it('onStateChange is invoked when circuit closes after probe', async () => {
    const onChange = jest.fn();
    const cb = makeCb({
      failureThreshold: 1,
      successThreshold: 1,
      resetMs: 5,
      onStateChange: onChange,
    });
    try { await cb.call(fail); } catch { /* open */ }
    await new Promise((r) => setTimeout(r, 10));
    await cb.call(succeed); // HALF_OPEN → CLOSED
    const calls = onChange.mock.calls;
    expect(calls.some(([, , to]) => to === 'CLOSED')).toBe(true);
  });

  it('onCall is invoked on success', async () => {
    const onCall = jest.fn();
    const cb = makeCb({ onCall });
    await cb.call(succeed);
    expect(onCall).toHaveBeenCalledWith('test', true, expect.any(Number), 'CLOSED');
  });

  it('onCall is invoked on failure', async () => {
    const onCall = jest.fn();
    const cb = makeCb({ onCall });
    try { await cb.call(fail); } catch { /* expected */ }
    expect(onCall).toHaveBeenCalledWith('test', false, expect.any(Number), expect.any(String));
  });

  it('onCall is NOT invoked when the circuit is OPEN (call is rejected before execution)', async () => {
    const onCall = jest.fn();
    const cb = makeCb({ failureThreshold: 1, onCall });
    try { await cb.call(fail); } catch { /* open */ }
    onCall.mockClear();
    try { await cb.call(succeed); } catch { /* CircuitOpenError */ }
    // The function was never executed so onCall must not fire.
    expect(onCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite 5 – withTimeout standalone
// ---------------------------------------------------------------------------

describe('withTimeout — standalone', () => {
  it('resolves when the function completes before the deadline', async () => {
    const result = await withTimeout(() => Promise.resolve(42), 500);
    expect(result).toBe(42);
  });

  it('throws DependencyTimeoutError on timeout', async () => {
    await expect(
      withTimeout(() => slow(300), 50, 'myDep'),
    ).rejects.toBeInstanceOf(DependencyTimeoutError);
  });

  it('re-throws the original error (not a timeout error) when the function rejects quickly', async () => {
    const originalErr = new Error('original');
    await expect(
      withTimeout(() => Promise.reject(originalErr), 500),
    ).rejects.toBe(originalErr);
  });

  it('uses the provided name in the DependencyTimeoutError message', async () => {
    const err = await withTimeout(
      () => slow(200),
      50,
      'postgres',
    ).catch((e) => e);
    expect(err.message).toMatch(/postgres/i);
  });
});

// ---------------------------------------------------------------------------
// Suite 6 – Fail-closed invariants
// ---------------------------------------------------------------------------

describe('CircuitBreaker — fail-closed invariants', () => {
  it('never returns a value when the circuit is OPEN', async () => {
    const cb = makeCb({ failureThreshold: 1 });
    try { await cb.call(fail); } catch { /* open */ }

    let resolved = false;
    try {
      await cb.call(succeed);
      resolved = true;
    } catch {
      // expected CircuitOpenError
    }
    expect(resolved).toBe(false);
  });

  it('never swallows the original error from the underlying function', async () => {
    const cb = makeCb();
    const specificError = new Error('very specific RPC error');
    await expect(
      cb.call(() => Promise.reject(specificError)),
    ).rejects.toBe(specificError);
  });

  it('CircuitOpenError is never confused with a normal application error', async () => {
    const cb = makeCb({ failureThreshold: 1 });
    try { await cb.call(fail); } catch { /* open */ }
    const err = await cb.call(succeed).catch((e) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect(err.name).toBe('CircuitOpenError');
  });

  it('DependencyTimeoutError name is always DependencyTimeoutError', async () => {
    const cb = makeCb();
    const err = await cb.call(() => slow(300), 50).catch((e) => e);
    expect(err.name).toBe('DependencyTimeoutError');
  });

  it('manual reset does not cause a call to return silently — it still executes fn', async () => {
    const cb = makeCb({ failureThreshold: 1 });
    try { await cb.call(fail); } catch { /* open */ }
    cb.reset();
    const result = await cb.call(succeed);
    expect(result).toBe('ok');
  });

  it('boundary: failureThreshold=1 opens after exactly one failure', async () => {
    const cb = makeCb({ failureThreshold: 1 });
    try { await cb.call(fail); } catch { /* expected */ }
    expect(cb.currentState).toBe('OPEN');
  });

  it('boundary: failureThreshold=10 stays CLOSED through 9 failures', async () => {
    const cb = makeCb({ failureThreshold: 10 });
    for (let i = 0; i < 9; i++) {
      try { await cb.call(fail); } catch { /* expected */ }
    }
    expect(cb.currentState).toBe('CLOSED');
  });
});

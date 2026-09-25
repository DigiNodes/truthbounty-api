/**
 * CircuitBreakerService
 *
 * A general-purpose, observable circuit breaker for protecting calls to
 * external dependencies (PostgreSQL, Redis, RPC providers, IPFS, etc.).
 *
 * State machine
 * -------------
 *   CLOSED  ──(failures ≥ threshold)──►  OPEN
 *   OPEN    ──(resetMs elapsed)──────►  HALF_OPEN
 *   HALF_OPEN ──(probe succeeds)───────►  CLOSED
 *   HALF_OPEN ──(probe fails)──────────►  OPEN
 *
 * Design invariants
 * -----------------
 * - Fail closed: when the circuit is OPEN every call throws immediately
 *   (CircuitOpenError) rather than queuing or silently returning null.
 * - No fabricated state: the caller decides how to handle an open circuit;
 *   this service never substitutes placeholder data.
 * - Metrics hooks: onStateChange and onCall callbacks allow Prometheus /
 *   structured-log integration without coupling.
 * - TypeORM-only boundary preserved: no Prisma imports.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Display name used in logs and metrics. */
  name: string;
  /** Number of consecutive failures before the circuit opens. Default: 5. */
  failureThreshold?: number;
  /** Number of consecutive successes in HALF_OPEN to close the circuit. Default: 1. */
  successThreshold?: number;
  /** Time in ms before an OPEN circuit transitions to HALF_OPEN. Default: 30_000. */
  resetMs?: number;
  /** Optional hook called on every state transition. */
  onStateChange?: (
    name: string,
    from: CircuitState,
    to: CircuitState,
  ) => void;
  /** Optional hook called after every protected call (success or failure). */
  onCall?: (
    name: string,
    success: boolean,
    durationMs: number,
    state: CircuitState,
  ) => void;
}

/** Thrown when a call is attempted while the circuit is OPEN. */
export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit "${name}" is OPEN — dependency unavailable, failing closed`);
    this.name = 'CircuitOpenError';
  }
}

/** Thrown when a protected call exceeds its timeout budget. */
export class DependencyTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(
      `Call to "${name}" timed out after ${timeoutMs}ms — failing closed`,
    );
    this.name = 'DependencyTimeoutError';
  }
}

export interface CircuitSnapshot {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  totalCalls: number;
  totalFailures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  openedAt: number | null;
  nextRetryAt: number | null;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private totalCalls = 0;
  private totalFailures = 0;
  private lastFailureAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private openedAt: number | null = null;

  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly resetMs: number;
  private readonly onStateChange?: CircuitBreakerOptions['onStateChange'];
  private readonly onCall?: CircuitBreakerOptions['onCall'];

  constructor(private readonly options: CircuitBreakerOptions) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 1;
    this.resetMs = options.resetMs ?? 30_000;
    this.onStateChange = options.onStateChange;
    this.onCall = options.onCall;
  }

  get name(): string {
    return this.options.name;
  }

  get currentState(): CircuitState {
    return this.state;
  }

  /**
   * Execute `fn` under circuit-breaker protection.
   *
   * @throws {CircuitOpenError} if the circuit is OPEN
   * @throws {DependencyTimeoutError} if `timeoutMs` is provided and exceeded
   * @throws the original error from `fn` on failure (circuit records it)
   */
  async call<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    this.maybeTransitionFromOpen();

    if (this.state === 'OPEN') {
      throw new CircuitOpenError(this.options.name);
    }

    const start = Date.now();
    this.totalCalls++;

    try {
      const result = timeoutMs
        ? await withTimeout(fn, timeoutMs, this.options.name)
        : await fn();

      this.onSuccess(Date.now() - start);
      return result;
    } catch (err) {
      this.onFailure(err, Date.now() - start);
      throw err;
    }
  }

  /** Returns an immutable snapshot of the current circuit state. */
  snapshot(): CircuitSnapshot {
    return {
      name: this.options.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      openedAt: this.openedAt,
      nextRetryAt: this.openedAt ? this.openedAt + this.resetMs : null,
    };
  }

  /** Manually reset the circuit to CLOSED. Useful for operator-driven recovery. */
  reset(): void {
    const prev = this.state;
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.openedAt = null;
    if (prev !== 'CLOSED') {
      this.onStateChange?.(this.options.name, prev, 'CLOSED');
    }
  }

  // ── private state transitions ─────────────────────────────────────────────

  private onSuccess(durationMs: number): void {
    this.lastSuccessAt = Date.now();
    this.failures = 0;

    if (this.state === 'HALF_OPEN') {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this.transition('CLOSED');
      }
    }

    this.onCall?.(this.options.name, true, durationMs, this.state);
  }

  private onFailure(err: unknown, durationMs: number): void {
    this.lastFailureAt = Date.now();
    this.totalFailures++;
    this.failures++;
    this.successes = 0;

    if (
      (this.state === 'CLOSED' || this.state === 'HALF_OPEN') &&
      this.failures >= this.failureThreshold
    ) {
      this.transition('OPEN');
    }

    this.onCall?.(this.options.name, false, durationMs, this.state);
  }

  private maybeTransitionFromOpen(): void {
    if (
      this.state === 'OPEN' &&
      this.openedAt !== null &&
      Date.now() >= this.openedAt + this.resetMs
    ) {
      this.transition('HALF_OPEN');
    }
  }

  private transition(next: CircuitState): void {
    const prev = this.state;
    this.state = next;
    if (next === 'OPEN') {
      this.openedAt = Date.now();
    } else if (next === 'CLOSED') {
      this.openedAt = null;
      this.failures = 0;
      this.successes = 0;
    } else if (next === 'HALF_OPEN') {
      this.successes = 0;
      this.failures = 0;
    }
    this.onStateChange?.(this.options.name, prev, next);
  }
}

/**
 * Wrap a promise-returning function with a hard timeout.
 * @throws {DependencyTimeoutError} when `timeoutMs` is exceeded.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  name = 'dependency',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DependencyTimeoutError(name, timeoutMs));
    }, timeoutMs);

    fn()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

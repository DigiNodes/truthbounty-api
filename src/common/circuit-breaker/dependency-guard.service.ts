/**
 * DependencyGuardService
 *
 * A NestJS-injectable façade that owns one CircuitBreaker per named
 * dependency and exposes:
 *
 *  - `guard(name, fn, timeoutMs?)` — execute `fn` under the named breaker
 *  - `status()` — current snapshot of every registered circuit
 *  - `reset(name)` — operator-triggered manual circuit reset
 *
 * Registered dependency names (authoritative list):
 *   'database'  — PostgreSQL / TypeORM DataSource
 *   'redis'     — ioredis cache layer
 *   'rpc'       — Optimism/EVM JSON-RPC provider
 *   'ipfs'      — IPFS gateway
 *   'queue'     — BullMQ / Redis queue
 *
 * Design invariants
 * -----------------
 * - Fail closed: an open circuit throws CircuitOpenError; callers must handle
 *   it explicitly — no silent fallback to fabricated state.
 * - Observable: every state transition and call result is emitted through the
 *   injected logger so Prometheus / alerting can pick it up.
 * - No Prisma or alternate-ORM imports.
 * - No backend-authoritative settlement / claim / dispute mutation.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitOpenError,
  CircuitSnapshot,
  DependencyTimeoutError,
  withTimeout,
} from './circuit-breaker.service';

export { CircuitOpenError, DependencyTimeoutError, withTimeout };

/**
 * Per-dependency timeout defaults (ms).
 * Operators may override via environment variables.
 */
const DEFAULT_TIMEOUTS: Record<string, number> = {
  database: 5_000,
  redis: 2_000,
  rpc: 10_000,
  ipfs: 15_000,
  queue: 5_000,
};

/**
 * Per-dependency circuit-breaker defaults.
 * Fail-threshold is intentionally low for chain/finality-critical paths.
 */
const DEFAULT_BREAKER_OPTIONS: Partial<CircuitBreakerOptions> = {
  failureThreshold: 5,
  successThreshold: 2,
  resetMs: 30_000,
};

@Injectable()
export class DependencyGuardService {
  private readonly logger = new Logger(DependencyGuardService.name);
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    @Optional() private readonly configService?: ConfigService,
  ) {
    // Register the canonical set of dependency circuits at construction time.
    const deps = ['database', 'redis', 'rpc', 'ipfs', 'queue'];
    for (const dep of deps) {
      this.register(dep);
    }
  }

  /**
   * Register (or replace) a named circuit breaker.
   * Idempotent: re-registering an existing name resets it to CLOSED.
   */
  register(name: string, opts: Partial<CircuitBreakerOptions> = {}): void {
    const threshold =
      this.configEnvNum(`CB_FAILURE_THRESHOLD_${name.toUpperCase()}`) ??
      opts.failureThreshold ??
      DEFAULT_BREAKER_OPTIONS.failureThreshold ??
      5;

    const resetMs =
      this.configEnvNum(`CB_RESET_MS_${name.toUpperCase()}`) ??
      opts.resetMs ??
      DEFAULT_BREAKER_OPTIONS.resetMs ??
      30_000;

    const breaker = new CircuitBreaker({
      name,
      failureThreshold: threshold,
      successThreshold:
        opts.successThreshold ??
        DEFAULT_BREAKER_OPTIONS.successThreshold ??
        2,
      resetMs,
      onStateChange: (n, from, to) => {
        const level = to === 'OPEN' ? 'error' : 'warn';
        this.logger[level](
          `[CircuitBreaker] "${n}" transitioned ${from} → ${to}`,
        );
      },
      onCall: (n, success, durationMs, state) => {
        if (!success) {
          this.logger.warn(
            `[CircuitBreaker] "${n}" call failed in ${durationMs}ms (state=${state})`,
          );
        }
      },
    });

    this.breakers.set(name, breaker);
  }

  /**
   * Execute `fn` under the named circuit breaker with an optional timeout.
   *
   * If no timeout is provided the per-dependency default from
   * DEFAULT_TIMEOUTS (or DEPENDENCY_TIMEOUT_<NAME> env var) is used.
   * Pass `timeoutMs=0` to disable the timeout entirely.
   *
   * @throws {CircuitOpenError}       when the circuit is OPEN
   * @throws {DependencyTimeoutError} when the call exceeds its budget
   * @throws the original error from `fn` on any other failure
   */
  async guard<T>(
    dependencyName: string,
    fn: () => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const breaker = this.getOrRegister(dependencyName);

    const effectiveTimeout =
      timeoutMs !== undefined
        ? timeoutMs
        : this.configEnvNum(
            `DEPENDENCY_TIMEOUT_${dependencyName.toUpperCase()}`,
          ) ?? DEFAULT_TIMEOUTS[dependencyName];

    // timeoutMs=0 means no timeout.
    const boundFn =
      effectiveTimeout && effectiveTimeout > 0
        ? () => withTimeout(fn, effectiveTimeout, dependencyName)
        : fn;

    return breaker.call(boundFn);
  }

  /** Return snapshots of all registered circuits. */
  status(): CircuitSnapshot[] {
    return Array.from(this.breakers.values()).map((b) => b.snapshot());
  }

  /** Return a single circuit's snapshot (throws if not registered). */
  snapshot(name: string): CircuitSnapshot {
    const breaker = this.breakers.get(name);
    if (!breaker) {
      throw new Error(`No circuit registered for dependency "${name}"`);
    }
    return breaker.snapshot();
  }

  /**
   * Manually reset a named circuit to CLOSED.
   * Intended for operator-driven recovery (e.g., admin endpoint).
   */
  reset(name: string): void {
    const breaker = this.breakers.get(name);
    if (!breaker) {
      this.logger.warn(`[CircuitBreaker] reset called for unknown circuit "${name}"`);
      return;
    }
    this.logger.warn(`[CircuitBreaker] manual reset of circuit "${name}"`);
    breaker.reset();
  }

  // ── private helpers ───────────────────────────────────────────────────────

  private getOrRegister(name: string): CircuitBreaker {
    if (!this.breakers.has(name)) {
      this.logger.warn(
        `[CircuitBreaker] auto-registering unknown dependency "${name}"`,
      );
      this.register(name);
    }
    return this.breakers.get(name)!;
  }

  private configEnvNum(key: string): number | undefined {
    if (!this.configService) return undefined;
    const raw = this.configService.get<string>(key);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
}

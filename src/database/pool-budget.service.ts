import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  buildPoolConfig,
  PoolConfig,
  POOL_LIMITS,
  Workload,
  WORKLOADS,
} from './pool.config';
import { getRuntimeEnvironment } from '../config/runtime-config';

/**
 * Minimal, dependency-free sink used to report budget events into the
 * Prometheus layer without coupling the database module to the metrics
 * module (which would create an import cycle).
 *
 * Implemented by `MetricsService`; every method is optional so unit tests
 * can omit it.
 */
export interface PoolMetricsSink {
  incrementDbAcquisitionTimeout?(workload: string): void;
  incrementDbStatementTimeout?(workload: string): void;
  incrementDbBudgetRejected?(workload: string): void;
}

/**
 * Thrown when a workload's connection budget is exhausted or the acquisition
 * deadline elapses. Fail-closed: callers must treat this as "try again later"
 * and must not hold a partial transaction open.
 */
export class PoolBudgetExhaustedError extends Error {
  readonly name = 'PoolBudgetExhaustedError';
  readonly workload: Workload;
  readonly waitedMs: number;

  constructor(workload: Workload, waitedMs: number, budget: number) {
    super(
      `Database connection budget exhausted for workload "${workload}" ` +
        `(budget=${budget}, waited ${waitedMs}ms). Retry with backoff.`,
    );
    this.workload = workload;
    this.waitedMs = waitedMs;
  }
}

/** Snapshot of budget usage — every field is a finite, non-negative integer. */
export interface WorkloadBudgetSnapshot {
  workload: Workload;
  budget: number;
  inUse: number;
  waiting: number;
  acquisitionTimeouts: number;
  rejections: number;
}

/**
 * Aggregate, bounded pool-budget metrics. All counters are monotonically
 * increasing integers; `inUse`/`waiting`/`budget` are clamped to safe ranges
 * so the payload can never contain NaN, Infinity, or negative values.
 */
export interface PoolBudgetMetrics {
  poolMax: number;
  acquireTimeoutMs: number;
  statementTimeoutMs: number;
  idleTransactionTimeoutMs: number;
  transactionDeadlineMs: number;
  totalInUse: number;
  totalWaiting: number;
  totalAcquisitionTimeouts: number;
  totalRejections: number;
  byWorkload: Record<Workload, WorkloadBudgetSnapshot>;
}

/** Resolved per-workload semaphore slot. */
interface Slot {
  /** Hands the slot to a waiter (a connection was released). */
  grant: () => void;
  /** Rejects the waiter (shutdown drain or cancellation). */
  drain: () => void;
}

/**
 * PoolBudgetService enforces per-workload connection budgets in front of the
 * shared PostgreSQL pool.
 *
 * ## Why
 *
 * The `pg` pool itself is global: if background jobs (BullMQ, cron, outbox)
 * saturate it, interactive API requests queue until the acquisition timeout
 * and the whole API appears down. Splitting the pool into separate physical
 * pools would waste connections, so instead each workload is granted a
 * *logical* budget (a counting semaphore). A workload that exhausts its
 * budget fails fast with {@link PoolBudgetExhaustedError} instead of
 * blocking every other workload.
 *
 * ## Guarantees
 *
 * - **Requests cannot exhaust the pool indefinitely.** Each workload has a
 *   hard budget; acquisitions beyond it reject after at most
 *   `acquireTimeoutMs`.
 * - **Timed-out work is cancelled/rolled back.** The budget slot is released
 *   in a `finally` block, and the paired {@link TransactionRunner} enforces
 *   server-side statement and idle-transaction timeouts.
 * - **Metrics are bounded and sanitized.** Only a closed set of workload
 *   labels is ever recorded; every emitted number is clamped to a finite,
 *   non-negative integer.
 * - **Background jobs have separate budgets.** {@link Workload.JOBS} has its
 *   own budget, so job bursts cannot starve {@link Workload.API}.
 */
@Injectable()
export class PoolBudgetService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PoolBudgetService.name);
  private config: PoolConfig;

  /** Current in-flight acquisitions per workload. */
  private readonly inUse = new Map<Workload, number>();
  /** Currently-waiting acquisitions per workload. */
  private readonly waiting = new Map<Workload, number>();
  /** Cumulative acquisition timeouts (deadline elapsed) per workload. */
  private readonly acquisitionTimeouts = new Map<Workload, number>();
  /** Cumulative hard rejections (budget already full) per workload. */
  private readonly rejections = new Map<Workload, number>();

  /** FIFO waiters per workload so releases are handed out fairly. */
  private readonly waiters = new Map<Workload, Slot[]>();

  private shuttingDown = false;

  /** Optional Prometheus sink; wired lazily to avoid a module import cycle. */
  private metricsSink: PoolMetricsSink | null = null;

  constructor() {
    this.config = buildPoolConfig(getRuntimeEnvironment(), this.logger);
    this.resetCounters();
  }

  onModuleInit(): Promise<void> {
    this.logger.log(
      `Pool budgets active: max=${this.config.poolMax}, ` +
        `acquire=${this.config.acquireTimeoutMs}ms, ` +
        `statement=${this.config.statementTimeoutMs}ms, ` +
        `idleTx=${this.config.idleTransactionTimeoutMs}ms, ` +
        `budgets=${JSON.stringify(this.config.budgets)}`,
    );
    return Promise.resolve();
  }

  onModuleDestroy(): Promise<void> {
    return this.shutdown();
  }

  /** Returns the resolved (clamped) configuration. Contains no secrets. */
  getConfig(): PoolConfig {
    return this.config;
  }

  /**
   * Attaches a Prometheus sink so budget rejections and acquisition
   * timeouts are exported as bounded, workload-labeled counters.
   * Called once during module bootstrap; safe to omit in unit tests.
   */
  setMetricsSink(sink: PoolMetricsSink | null): void {
    this.metricsSink = sink;
  }

  /**
   * Acquires a budget slot for `workload`, runs `fn`, then releases the slot.
   *
   * Rejects with {@link PoolBudgetExhaustedError} if the workload's budget is
   * full for longer than the acquisition timeout, or if the service is shutting
   * down. The slot is **always** released, even when `fn` throws.
   */
  async run<T>(
    workload: Workload,
    fn: () => Promise<T>,
    options: { acquireTimeoutMs?: number } = {},
  ): Promise<T> {
    const release = await this.acquire(workload, options.acquireTimeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Acquires a budget slot for `workload` and returns a release function.
   * Prefer {@link run} which guarantees release in a `finally` block.
   */
  async acquire(
    workload: Workload,
    acquireTimeoutMsOverride?: number,
  ): Promise<() => void> {
    const wl = WORKLOADS.includes(workload) ? workload : Workload.DEFAULT;
    if (this.shuttingDown) {
      this.bump(this.rejections, wl);
      this.metricsSink?.incrementDbBudgetRejected?.(wl);
      throw new PoolBudgetExhaustedError(wl, 0, this.config.budgets[wl]);
    }

    const budget = this.config.budgets[wl];
    const current = this.inUse.get(wl) ?? 0;

    if (current < budget) {
      this.inUse.set(wl, current + 1);
      return this.makeRelease(wl);
    }

    // Budget exhausted — wait (fairly) for a release, bounded by the timeout.
    const timeoutMs = Math.min(
      acquireTimeoutMsOverride ?? this.config.acquireTimeoutMs,
      POOL_LIMITS.acquireTimeoutMs.max,
    );
    this.bump(this.waiting, wl);
    try {
      await this.waitForSlot(wl, timeoutMs);
    } catch {
      if (this.shuttingDown) {
        this.bump(this.rejections, wl);
        this.metricsSink?.incrementDbBudgetRejected?.(wl);
        throw new PoolBudgetExhaustedError(wl, 0, budget);
      }
      // Acquisition deadline elapsed.
      this.bump(this.acquisitionTimeouts, wl);
      this.metricsSink?.incrementDbAcquisitionTimeout?.(wl);
      throw new PoolBudgetExhaustedError(wl, timeoutMs, budget);
    } finally {
      this.dec(this.waiting, wl);
    }

    this.bump(this.inUse, wl);
    return this.makeRelease(wl);
  }

  /** Current in-flight count for a workload (0 when idle). */
  getInUse(workload: Workload): number {
    return this.inUse.get(workload) ?? 0;
  }

  /**
   * Returns a bounded, sanitized metrics snapshot.
   *
   * Every number is clamped to a finite non-negative integer; the workload
   * map is a closed set (no caller-controlled labels), so metric cardinality
   * cannot grow without bound.
   */
  getMetrics(): PoolBudgetMetrics {
    const byWorkload = {} as Record<Workload, WorkloadBudgetSnapshot>;
    for (const wl of WORKLOADS) {
      byWorkload[wl] = this.snapshotFor(wl);
    }
    return {
      poolMax: this.config.poolMax,
      acquireTimeoutMs: this.config.acquireTimeoutMs,
      statementTimeoutMs: this.config.statementTimeoutMs,
      idleTransactionTimeoutMs: this.config.idleTransactionTimeoutMs,
      transactionDeadlineMs: this.config.transactionDeadlineMs,
      totalInUse: this.sum(this.inUse),
      totalWaiting: this.sum(this.waiting),
      totalAcquisitionTimeouts: this.sum(this.acquisitionTimeouts),
      totalRejections: this.sum(this.rejections),
      byWorkload,
    };
  }

  /**
   * Drains all waiters and stops accepting new work. In-flight `fn` callbacks
   * continue to run; their slots are released when they finish. Waiting
   * acquisitions are rejected (fail-closed) rather than silently granted.
   * Called from `onModuleDestroy` and from the application shutdown path.
   */
  shutdown(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    this.shuttingDown = true;
    let drained = 0;
    for (const wl of WORKLOADS) {
      const queue = this.waiters.get(wl) ?? [];
      drained += queue.length;
      for (const waiter of queue) {
        waiter.drain();
      }
      this.waiters.set(wl, []);
    }
    if (drained > 0) {
      this.logger.warn(
        `Pool budget shutdown drained ${drained} waiting acquisition(s)`,
      );
    }
    return Promise.resolve();
  }

  /** True once {@link shutdown} has begun. */
  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  // ── internal ──────────────────────────────────────────────────────────

  private makeRelease(wl: Workload): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.dec(this.inUse, wl);
      this.handOff(wl);
    };
  }

  private handOff(wl: Workload): void {
    const queue = this.waiters.get(wl);
    if (!queue || queue.length === 0) return;
    const next = queue.shift()!;
    next.grant();
  }

  private waitForSlot(wl: Workload, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const budget = this.config.budgets[wl];
      const inUse = this.inUse.get(wl) ?? 0;
      if (this.shuttingDown) {
        reject(new PoolBudgetExhaustedError(wl, 0, budget));
        return;
      }
      if (inUse < budget) {
        resolve();
        return;
      }

      let settled = false;
      const slot: Slot = {
        grant: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        drain: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new PoolBudgetExhaustedError(wl, 0, budget));
        },
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const queue = this.waiters.get(wl);
        if (queue) {
          const idx = queue.indexOf(slot);
          if (idx >= 0) queue.splice(idx, 1);
        }
        reject(new PoolBudgetExhaustedError(wl, timeoutMs, budget));
      }, timeoutMs);
      // Do not keep the event loop alive solely for a budget waiter.
      if (typeof timer.unref === 'function') timer.unref();

      if (!this.waiters.has(wl)) this.waiters.set(wl, []);
      this.waiters.get(wl)!.push(slot);
    });
  }

  private bump(map: Map<Workload, number>, wl: Workload): void {
    map.set(wl, (map.get(wl) ?? 0) + 1);
  }

  private dec(map: Map<Workload, number>, wl: Workload): void {
    map.set(wl, Math.max(0, (map.get(wl) ?? 0) - 1));
  }

  private sum(map: Map<Workload, number>): number {
    let total = 0;
    for (const v of map.values()) {
      if (Number.isFinite(v)) total += Math.max(0, Math.floor(v));
    }
    return total;
  }

  private snapshotFor(wl: Workload): WorkloadBudgetSnapshot {
    const budget = this.config.budgets[wl] ?? 0;
    return {
      workload: wl,
      budget: clampInt(budget),
      inUse: clampInt(this.inUse.get(wl)),
      waiting: clampInt(this.waiting.get(wl)),
      acquisitionTimeouts: clampInt(this.acquisitionTimeouts.get(wl)),
      rejections: clampInt(this.rejections.get(wl)),
    };
  }

  private resetCounters(): void {
    for (const wl of WORKLOADS) {
      this.inUse.set(wl, 0);
      this.waiting.set(wl, 0);
      this.acquisitionTimeouts.set(wl, 0);
      this.rejections.set(wl, 0);
      this.waiters.set(wl, []);
    }
  }
}

/** Clamps a possibly-undefined number to a finite, non-negative integer. */
function clampInt(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

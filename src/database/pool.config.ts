// Type-only import: `Logger` is only used as an optional parameter type, so
// this module carries no runtime dependency on NestJS and stays loadable from
// the standalone TypeORM CLI (`data-source.ts`).
import type { Logger } from '@nestjs/common';
import { getRuntimeEnvironment } from '../config/runtime-config';

/**
 * Workload classes that share the database connection pool.
 *
 * Each workload is granted its own budget so a runaway background job can
 * never starve interactive API requests (and vice versa). The set is a closed
 * enum: unknown workloads fail closed by falling back to {@link Workload.DEFAULT}.
 */
export enum Workload {
  /** Interactive HTTP request handlers. */
  API = 'api',
  /** BullMQ / cron / outbox background jobs. */
  JOBS = 'jobs',
  /** Administrative and internal operations (health, migrations, probes). */
  ADMIN = 'admin',
  /** Fallback class when no explicit workload is supplied. */
  DEFAULT = 'default',
}

/** All known workload names — used to bound metrics label cardinality. */
export const WORKLOADS: readonly Workload[] = Object.freeze([
  Workload.API,
  Workload.JOBS,
  Workload.ADMIN,
  Workload.DEFAULT,
]);

/**
 * Hard bounds applied to every configured value. Values outside the range are
 * clamped (fail-closed) rather than rejected, so a misconfigured environment
 * degrades to a safe pool instead of crashing or allowing unbounded use.
 */
export const POOL_LIMITS = Object.freeze({
  poolMax: { min: 1, max: 100 },
  poolMin: { min: 0, max: 50 },
  acquireTimeoutMs: { min: 1_000, max: 120_000 },
  statementTimeoutMs: { min: 1_000, max: 60_000 },
  idleTransactionTimeoutMs: { min: 1_000, max: 60_000 },
  transactionDeadlineMs: { min: 1_000, max: 300_000 },
  workloadBudget: { min: 1, max: 100 },
});

/** Resolved, validated pool configuration. All values are already clamped. */
export interface PoolConfig {
  /** Maximum connections in the shared PostgreSQL pool. */
  poolMax: number;
  /** Minimum idle connections maintained by the pool. */
  poolMin: number;
  /** How long a caller may wait for a free connection before acquisition fails. */
  acquireTimeoutMs: number;
  /** How long an idle (unused) connection is kept before being closed. */
  idleTimeoutMs: number;
  /** Server-side `statement_timeout` — cancels any single runaway statement. */
  statementTimeoutMs: number;
  /** Server-side `idle_in_transaction_session_timeout` — reclaims leaked transactions. */
  idleTransactionTimeoutMs: number;
  /** Application-side deadline for a whole transaction (guards the connection). */
  transactionDeadlineMs: number;
  /** Per-workload connection budgets; every workload has an entry. */
  budgets: Record<Workload, number>;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Reads an integer env var and clamps it into `[min, max]`.
 * Non-numeric or missing values fall back to `fallback` (fail-closed).
 */
function readInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
  logger?: Logger,
): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    logger?.warn(
      `Pool config ${name}="${raw}" is not an integer; using safe default ${fallback}`,
    );
    return clamp(fallback, min, max);
  }
  const clamped = clamp(parsed, min, max);
  if (clamped !== parsed) {
    logger?.warn(
      `Pool config ${name}=${parsed} is out of range [${min}, ${max}]; clamped to ${clamped}`,
    );
  }
  return clamped;
}

/**
 * Builds a validated {@link PoolConfig} from the process environment.
 *
 * Every value is clamped into {@link POOL_LIMITS} so that:
 * - a too-large pool cannot be requested (caps total connection pressure),
 * - a too-small or zero timeout cannot disable cancellation,
 * - per-workload budgets always sum to a sane share of the pool.
 *
 * The returned object is safe to log and to surface in bounded metrics: it
 * contains only finite integers and no connection secrets.
 */
export function buildPoolConfig(
  env: NodeJS.ProcessEnv = getRuntimeEnvironment(),
  logger?: Logger,
): PoolConfig {
  const poolMax = readInt(
    env.DB_POOL_MAX,
    20,
    POOL_LIMITS.poolMax.min,
    POOL_LIMITS.poolMax.max,
    'DB_POOL_MAX',
    logger,
  );
  const poolMin = readInt(
    env.DB_POOL_MIN,
    2,
    POOL_LIMITS.poolMin.min,
    Math.min(POOL_LIMITS.poolMin.max, poolMax),
    'DB_POOL_MIN',
    logger,
  );

  const acquireTimeoutMs = readInt(
    env.DB_POOL_ACQUIRE_TIMEOUT,
    30_000,
    POOL_LIMITS.acquireTimeoutMs.min,
    POOL_LIMITS.acquireTimeoutMs.max,
    'DB_POOL_ACQUIRE_TIMEOUT',
    logger,
  );
  const statementTimeoutMs = readInt(
    env.DB_STATEMENT_TIMEOUT,
    15_000,
    POOL_LIMITS.statementTimeoutMs.min,
    POOL_LIMITS.statementTimeoutMs.max,
    'DB_STATEMENT_TIMEOUT',
    logger,
  );
  const idleTransactionTimeoutMs = readInt(
    env.DB_IDLE_TRANSACTION_TIMEOUT,
    10_000,
    POOL_LIMITS.idleTransactionTimeoutMs.min,
    POOL_LIMITS.idleTransactionTimeoutMs.max,
    'DB_IDLE_TRANSACTION_TIMEOUT',
    logger,
  );
  const transactionDeadlineMs = readInt(
    env.DB_TRANSACTION_DEADLINE,
    30_000,
    POOL_LIMITS.transactionDeadlineMs.min,
    POOL_LIMITS.transactionDeadlineMs.max,
    'DB_TRANSACTION_DEADLINE',
    logger,
  );

  // Idle-connection timeout. Honors an explicit DB_POOL_IDLE_TIMEOUT; when
  // unset, derives a value that is at least twice the idle-transaction
  // timeout (so a reclaimed transaction's connection is not immediately
  // closed) and never shorter than the acquisition timeout.
  const derivedIdleTimeoutMs = Math.max(
    acquireTimeoutMs,
    idleTransactionTimeoutMs * 2,
  );
  const idleTimeoutMs = readInt(
    env.DB_POOL_IDLE_TIMEOUT,
    derivedIdleTimeoutMs,
    POOL_LIMITS.acquireTimeoutMs.min,
    POOL_LIMITS.acquireTimeoutMs.max,
    'DB_POOL_IDLE_TIMEOUT',
    logger,
  );

  // Per-workload budgets. Defaults keep interactive API headroom while
  // reserving a dedicated slice for background jobs so neither class can
  // exhaust the pool indefinitely on its own.
  const defaultBudgets: Record<Workload, number> = {
    [Workload.API]: Math.max(1, Math.floor(poolMax * 0.6)),
    [Workload.JOBS]: Math.max(1, Math.floor(poolMax * 0.3)),
    [Workload.ADMIN]: Math.max(1, Math.floor(poolMax * 0.1)),
    [Workload.DEFAULT]: Math.max(1, Math.floor(poolMax * 0.5)),
  };

  const budgets: Record<Workload, number> = {
    [Workload.API]: readInt(
      env.DB_POOL_BUDGET_API,
      defaultBudgets[Workload.API],
      POOL_LIMITS.workloadBudget.min,
      POOL_LIMITS.workloadBudget.max,
      'DB_POOL_BUDGET_API',
      logger,
    ),
    [Workload.JOBS]: readInt(
      env.DB_POOL_BUDGET_JOBS,
      defaultBudgets[Workload.JOBS],
      POOL_LIMITS.workloadBudget.min,
      POOL_LIMITS.workloadBudget.max,
      'DB_POOL_BUDGET_JOBS',
      logger,
    ),
    [Workload.ADMIN]: readInt(
      env.DB_POOL_BUDGET_ADMIN,
      defaultBudgets[Workload.ADMIN],
      POOL_LIMITS.workloadBudget.min,
      POOL_LIMITS.workloadBudget.max,
      'DB_POOL_BUDGET_ADMIN',
      logger,
    ),
    [Workload.DEFAULT]: readInt(
      env.DB_POOL_BUDGET_DEFAULT,
      defaultBudgets[Workload.DEFAULT],
      POOL_LIMITS.workloadBudget.min,
      POOL_LIMITS.workloadBudget.max,
      'DB_POOL_BUDGET_DEFAULT',
      logger,
    ),
  };

  return {
    poolMax,
    poolMin,
    acquireTimeoutMs,
    idleTimeoutMs,
    statementTimeoutMs,
    idleTransactionTimeoutMs,
    transactionDeadlineMs,
    budgets,
  };
}

/**
 * Builds the `extra` object passed to the `pg` driver.
 *
 * Besides the classic pool knobs, this injects the two server-side GUCs that
 * make timed-out work get cancelled/rolled back by PostgreSQL itself:
 * - `statement_timeout` cancels a single runaway statement,
 * - `idle_in_transaction_session_timeout` terminates a transaction left idle
 *   (a leaked transaction) so it cannot hold a connection forever.
 *
 * The returned object contains only finite integers — safe to serialize.
 */
export function buildPoolExtra(config: PoolConfig): Record<string, number> {
  return {
    max: config.poolMax,
    min: config.poolMin,
    connectionTimeoutMillis: config.acquireTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    idle_in_transaction_session_timeout: config.idleTransactionTimeoutMs,
  };
}

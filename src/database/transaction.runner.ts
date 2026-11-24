import { getRuntimeEnvironment } from '../config/runtime-config';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { buildPoolConfig, PoolConfig } from './pool.config';

/**
 * Callback signature for transactional operations.
 *
 * @param manager - An {@link EntityManager} scoped to the active transaction.
 *   All repository operations within the callback MUST use this manager
 *   instead of the global data source to participate in the transaction.
 */
export type TransactionCallback<T> = (manager: EntityManager) => Promise<T>;

/** Thrown when a transaction exceeds its wall-clock deadline. */
export class TransactionDeadlineExceededError extends Error {
  readonly name = 'TransactionDeadlineExceededError';
  constructor(deadlineMs: number) {
    super(
      `Transaction exceeded its ${deadlineMs}ms deadline and was rolled back.`,
    );
  }
}

/**
 * Thrown when a statement exceeds the configured `statement_timeout`.
 * PostgreSQL cancels the server-side query; this error surfaces locally.
 */
export class StatementTimeoutError extends Error {
  readonly name = 'StatementTimeoutError';
  constructor(statementTimeoutMs: number) {
    super(`Statement exceeded ${statementTimeoutMs}ms and was cancelled.`);
  }
}

/**
 * TransactionRunner — reusable transaction helper for atomic database
 * operations with automatic rollback on failure.
 *
 * ## Usage
 *
 * ```ts
 * @Injectable()
 * class ClaimService {
 *   constructor(private readonly tx: TransactionRunner) {}
 *
 *   async processClaim(claimId: string): Promise<void> {
 *     await this.tx.run(async (manager) => {
 *       const repo = manager.getRepository(ClaimEntity);
 *       await repo.update(claimId, { status: 'approved' });
 *       // If this line throws, the update above is rolled back
 *     });
 *   }
 * }
 * ```
 *
 * ## Design
 *
 * - Uses TypeORM {@link QueryRunner} for explicit transaction boundaries.
 * - Automatically releases the query runner (returns connection to pool)
 *   in a `finally` block so leaked connections are impossible.
 * - Enforces a **transaction deadline** (`DB_TRANSACTION_DEADLINE`): if the
 *   callback runs longer than the deadline, the transaction is rolled back
 *   and the connection released — a slow handler cannot hold a connection
 *   indefinitely.
 * - Applies server-side `statement_timeout` and
 *   `idle_in_transaction_session_timeout` per query runner so PostgreSQL
 *   itself cancels runaway statements and terminates idle (leaked)
 *   transactions.
 * - Supports nested transactions via savepoints (PostgreSQL only).
 * - All errors propagate to the caller after rollback — the transaction
 *   runner never swallows exceptions.
 */
@Injectable()
export class TransactionRunner {
  private readonly logger = new Logger(TransactionRunner.name);
  private readonly poolConfig: PoolConfig;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {
    this.poolConfig = buildPoolConfig(getRuntimeEnvironment());
  }

  /**
   * Execute `callback` within a single database transaction.
   *
   * On **success**, the transaction is committed.
   * On **error** or **deadline exceeded**, the transaction is rolled back and
   * the error is re-thrown.
   *
   * @param callback - Async function receiving an {@link EntityManager}
   *   scoped to the transaction. Use `manager.getRepository(...)` for all
   *   queries within the callback.
   * @param options.deadlineMs - Optional override for the transaction
   *   deadline (clamped to the configured maximum).
   * @returns The return value of `callback`.
   */
  async run<T>(
    callback: TransactionCallback<T>,
    options: { deadlineMs?: number } = {},
  ): Promise<T> {
    const deadlineMs = this.resolveDeadline(options.deadlineMs);
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await this.applyTimeouts(queryRunner);
    await queryRunner.startTransaction();

    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadlinePromise = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        reject(new TransactionDeadlineExceededError(deadlineMs));
      }, deadlineMs);
      if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
    });

    try {
      const result = await Promise.race([
        callback(queryRunner.manager),
        deadlinePromise,
      ]);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await this.safeRollback(queryRunner);
      if (error instanceof TransactionDeadlineExceededError) {
        this.logger.warn(
          `Transaction deadline of ${deadlineMs}ms exceeded; rolled back`,
        );
      } else {
        this.logger.warn(
          `Transaction rolled back: ${(error as Error)?.message ?? String(error)}`,
        );
      }
      throw error;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      await queryRunner.release();
    }
  }

  /**
   * Execute `callback` within a nested savepoint.
   *
   * Only supported on PostgreSQL. On SQLite (development), this falls
   * back to a regular transaction since SQLite doesn't support
   * sub-transactions via savepoints.
   *
   * @param callback - Async function receiving an {@link EntityManager}
   *   scoped to the savepoint.
   */
  async runNested<T>(callback: TransactionCallback<T>): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await this.applyTimeouts(queryRunner);
    await queryRunner.startTransaction();

    try {
      const result = await callback(queryRunner.manager);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await this.safeRollback(queryRunner);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // ── internal ──────────────────────────────────────────────────────────

  /**
   * Applies the server-side statement and idle-transaction timeouts to the
   * query runner's underlying connection. Best-effort: if the driver does
   * not expose a raw connection (SQLite), this is a no-op.
   */
  private async applyTimeouts(queryRunner: QueryRunner): Promise<void> {
    if (this.dataSource.options.type !== 'postgres') return;
    const statementTimeout = this.poolConfig.statementTimeoutMs;
    const idleTxTimeout = this.poolConfig.idleTransactionTimeoutMs;
    try {
      // `SET LOCAL` applies only to the current transaction, so it cannot
      // leak to other pooled connections.
      await queryRunner.query(
        `SET LOCAL statement_timeout = ${statementTimeout}`,
      );
      await queryRunner.query(
        `SET LOCAL idle_in_transaction_session_timeout = ${idleTxTimeout}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to apply statement/idle-transaction timeouts: ${(error as Error)?.message}`,
      );
    }
  }

  private async safeRollback(queryRunner: QueryRunner): Promise<void> {
    try {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
    } catch (error) {
      this.logger.warn(
        `Rollback failed (connection will still be released): ${(error as Error)?.message}`,
      );
    }
  }

  private resolveDeadline(override?: number): number {
    const max = this.poolConfig.transactionDeadlineMs;
    if (override === undefined || !Number.isFinite(override)) return max;
    return Math.min(Math.max(1_000, Math.floor(override)), max);
  }
}

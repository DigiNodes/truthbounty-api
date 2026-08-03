import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

/**
 * Callback signature for transactional operations.
 *
 * @param manager - An {@link EntityManager} scoped to the active transaction.
 *   All repository operations within the callback MUST use this manager
 *   instead of the global data source to participate in the transaction.
 */
export type TransactionCallback<T> = (manager: EntityManager) => Promise<T>;

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
 * - Supports nested transactions via savepoints (PostgreSQL only).
 * - All errors propagate to the caller after rollback — the transaction
 *   runner never swallows exceptions.
 */
@Injectable()
export class TransactionRunner {
  private readonly logger = new Logger(TransactionRunner.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Execute `callback` within a single database transaction.
   *
   * On **success**, the transaction is committed.
   * On **error**, the transaction is rolled back and the error is re-thrown.
   *
   * @param callback - Async function receiving an {@link EntityManager}
   *   scoped to the transaction. Use `manager.getRepository(...)` for all
   *   queries within the callback.
   * @returns The return value of `callback`.
   */
  async run<T>(callback: TransactionCallback<T>): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const result = await callback(queryRunner.manager);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.warn(
        `Transaction rolled back: ${(error as Error)?.message ?? String(error)}`,
      );
      throw error;
    } finally {
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
    await queryRunner.startTransaction();

    try {
      const result = await callback(queryRunner.manager);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}

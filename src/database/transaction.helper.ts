import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

/**
 * TransactionHelper provides reusable transaction management utilities
 * supporting atomic operations, rollback, and nested transactions.
 */
@Injectable()
export class TransactionHelper {
  private readonly logger = new Logger(TransactionHelper.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Execute a callback within a database transaction.
   * Automatically commits on success and rolls back on error.
   *
   * @param work - Async callback receiving the transaction EntityManager
   * @returns The result of the work callback
   */
  async withTransaction<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const result = await work(queryRunner.manager);
      await queryRunner.commitTransaction();
      return result;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      this.logger.warn(`Transaction rolled back: ${err.message}`);
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Execute a callback within a transaction using the provided EntityManager.
   * If the manager is already in a transaction, it participates in that
   * transaction (nested transaction support via savepoints).
   *
   * @param manager - The EntityManager to use (or create a new transaction)
   * @param work - Async callback receiving the transaction EntityManager
   */
  async withTransactionManager<T>(
    manager: EntityManager,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    // If we're already in a transaction, use savepoints for nesting
    if (manager.queryRunner?.isTransactionActive) {
      const queryRunner = manager.queryRunner;
      await queryRunner.startTransaction();
      try {
        const result = await work(manager);
        await queryRunner.commitTransaction();
        return result;
      } catch (err) {
        await queryRunner.rollbackTransaction();
        throw err;
      }
    }

    return this.withTransaction(work);
  }

  /**
   * Execute multiple operations atomically.
   * All operations succeed or all are rolled back.
   *
   * @param operations - Array of async operations to execute in a transaction
   */
  async executeAtomic<T>(
    operations: Array<(manager: EntityManager) => Promise<T>>,
  ): Promise<T[]> {
    return this.withTransaction(async (manager) => {
      const results: T[] = [];
      for (const op of operations) {
        results.push(await op(manager));
      }
      return results;
    });
  }
}

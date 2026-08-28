import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * DatabaseService manages the PostgreSQL connection lifecycle and
 * provides health reporting information for the monitoring module.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    if (!this.dataSource.isInitialized) {
      await this.dataSource.initialize();
      this.logger.log('PostgreSQL connection established');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
      this.logger.log('PostgreSQL connection closed');
    }
  }

  /**
   * Check database connectivity with latency measurement.
   */
  async checkConnectivity(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (err) {
      this.logger.error(`Database connectivity check failed: ${err.message}`);
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }

  /**
   * Get migration status (applied vs pending migrations).
   */
  async getMigrationStatus(): Promise<{
    applied: number;
    pending: number;
    migrations: Array<{ name: string; timestamp: number }>;
  }> {
    const migrations = await this.dataSource.runMigrations({ transaction: 'none' });
    const allMigrations = this.dataSource.migrations;
    const appliedMigrations = await this.dataSource.query(
      'SELECT name, "timestamp" FROM migrations ORDER BY "timestamp"',
    );

    return {
      applied: appliedMigrations.length,
      pending: allMigrations.length - appliedMigrations.length,
      migrations: appliedMigrations.map((m: { name: string; timestamp: number }) => ({
        name: m.name,
        timestamp: m.timestamp,
      })),
    };
  }

  /**
   * Get connection pool utilization metrics.
   */
  async getPoolMetrics(): Promise<{
    total: number;
    idle: number;
    active: number;
    waiting: number;
  }> {
    const pool = (this.dataSource.driver as any).master;
    if (!pool) {
      return { total: 0, idle: 0, active: 0, waiting: 0 };
    }

    return {
      total: pool.totalCount ?? 0,
      idle: pool.idleCount ?? 0,
      active: pool.totalCount ? pool.totalCount - (pool.idleCount ?? 0) : 0,
      waiting: pool.waitingCount ?? 0,
    };
  }
}

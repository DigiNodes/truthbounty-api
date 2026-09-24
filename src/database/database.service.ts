import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Database connectivity and pool health information.
 */
export interface DatabaseHealth {
  /** Whether the database connection is active and responding. */
  connected: boolean;
  /** Round-trip latency of a `SELECT 1` ping, in milliseconds. */
  latencyMs: number | null;
  /** Whether migrations have been applied (reads migration table). */
  migrationsApplied: boolean;
  /** Number of active connections in the pool (TypeORM `pg` driver). */
  poolActive: number | null;
  /** Total connection pool size (max configured). */
  poolTotal: number | null;
  /** Error message if the health check failed. */
  error?: string;
}

/**
 * DatabaseService manages the PostgreSQL connection lifecycle and
 * provides health reporting information for the monitoring module.
 *
 * ## Usage
 *
 * Inject `DatabaseService` into `HealthController` (or any monitoring
 * endpoint) and call `getHealth()` to obtain a snapshot of database status.
 *
 * ## Design
 *
 * Health-check methods are lightweight (`SELECT 1`, `pg_stat_activity`
 * snapshot) and designed to never throw. Errors are captured in the
 * returned `DatabaseHealth.error` field so health endpoints always
 * return 200 with status detail rather than crashing.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

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
   * Returns a point-in-time snapshot of database health.
   *
   * Performs:
   * 1. Connectivity check (`SELECT 1`)
   * 2. Migration status check (reads `migrations` table)
   * 3. Connection pool stats (reads `pg_stat_activity`)
   */
  async getHealth(): Promise<DatabaseHealth> {
    const result: DatabaseHealth = {
      connected: false,
      latencyMs: null,
      migrationsApplied: false,
      poolActive: null,
      poolTotal: null,
    };

    try {
      // ── 1. Connectivity + latency ──────────────────────────────
      const pingStart = Date.now();
      const pingResult = await this.dataSource.query('SELECT 1 AS ok');
      result.latencyMs = Date.now() - pingStart;
      result.connected = pingResult?.[0]?.ok === 1;
    } catch (error) {
      result.error = `Connectivity check failed: ${(error as Error)?.message ?? String(error)}`;
      this.logger.error('Database connectivity check failed', error);
      return result;
    }

    try {
      // ── 2. Migration status ────────────────────────────────────
      const hasMigrationsTable = await this.dataSource.query(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_name = 'migrations'
        ) AS exists`,
      );
      if (hasMigrationsTable?.[0]?.exists) {
        const migrationCount = await this.dataSource.query(
          'SELECT COUNT(*) AS count FROM migrations',
        );
        result.migrationsApplied = Number(migrationCount?.[0]?.count ?? 0) > 0;
      } else {
        // No migrations table — either first deploy or TypeORM hasn't run yet
        result.migrationsApplied = false;
      }
    } catch {
      // Best-effort: migration table may not exist on fresh deploys
      result.migrationsApplied = false;
    }

    try {
      // ── 3. Connection pool stats ───────────────────────────────
      if (this.dataSource.options.type === 'postgres') {
        const poolStats = await this.dataSource.query(
          `SELECT count(*) AS active
           FROM pg_stat_activity
           WHERE state = 'active'`,
        );
        result.poolActive = Number(poolStats?.[0]?.active ?? 0);
        result.poolTotal = (this.dataSource.options.extra as any)?.max ?? null;
      }
    } catch {
      // Pool stats are only available for PostgreSQL
    }

    return result;
  }

  /**
   * Returns `true` if the database connection is healthy and responsive.
   * Lightweight — suitable for Kubernetes liveness probes.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const result = await this.dataSource.query('SELECT 1 AS ok');
      return result?.[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  /**
   * Returns the underlying TypeORM DataSource for advanced use cases
   * (e.g., raw queries outside of the repository pattern).
   */
  getDataSource(): DataSource {
    return this.dataSource;
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
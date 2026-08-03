import { Injectable, Logger } from '@nestjs/common';
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
 * DatabaseService — exposes database health, connectivity, and pool
 * statistics for the monitoring/health-check module.
 *
 * ## Usage
 *
 * Inject `DatabaseService` into `HealthController` (or any monitoring
 * endpoint) and call `getHealth()` to obtain a snapshot of database status.
 *
 * ## Design
 *
 * All queries are lightweight (`SELECT 1`, `pg_stat_activity` snapshot)
 * and designed to never throw. Errors are captured in the returned
 * `DatabaseHealth.error` field so health endpoints always return 200
 * with status detail rather than crashing.
 */
@Injectable()
export class DatabaseService {
  private readonly logger = new Logger(DatabaseService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

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
}

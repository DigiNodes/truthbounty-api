import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface DatabaseReadinessReport {
  ready: boolean;
  status: 'HEALTHY' | 'UNHEALTHY';
  latencyMs: number;
  hasPendingMigrations: boolean;
  schemaVersion: number | null;
  failureReason?: string;
  timestamp: string;
}

@Injectable()
export class DatabaseReadinessService {
  private readonly logger = new Logger(DatabaseReadinessService.name);
  private readonly REQUIRED_SCHEMA_VERSION = 2;

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Evaluates the complete database readiness gate:
   * 1. Connection alive
   * 2. No pending migrations
   * 3. V2 schema baseline matched
   */
  async checkReadiness(): Promise<DatabaseReadinessReport> {
    const start = Date.now();
    const timestamp = new Date().toISOString();

    if (!this.dataSource?.isInitialized) {
      return {
        ready: false,
        status: 'UNHEALTHY',
        latencyMs: 0,
        hasPendingMigrations: true,
        schemaVersion: null,
        failureReason: 'Database DataSource is not initialized',
        timestamp,
      };
    }

    try {
      // 1. Ping / Connectivity
      await this.dataSource.query('SELECT 1');
      const latencyMs = Date.now() - start;

      // 2. Migration gate: Ensure no unapplied/pending migrations exist
      const hasPendingMigrations = await this.dataSource.showMigrations();
      if (hasPendingMigrations) {
        return {
          ready: false,
          status: 'UNHEALTHY',
          latencyMs,
          hasPendingMigrations: true,
          schemaVersion: null,
          failureReason: 'Pending database migrations detected. Schema is not synchronized.',
          timestamp,
        };
      }

      // 3. Schema version verification (V2 baseline)
      const schemaTableCheck = await this.dataSource.query(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'v2_schema_versions');`,
      );

      if (!schemaTableCheck[0]?.exists) {
        return {
          ready: false,
          status: 'UNHEALTHY',
          latencyMs,
          hasPendingMigrations: false,
          schemaVersion: null,
          failureReason: 'v2_schema_versions table is missing. Database is not at V2 baseline.',
          timestamp,
        };
      }

      const versionResult = await this.dataSource.query(
        `SELECT MAX(version) as current_version FROM "v2_schema_versions";`,
      );

      const currentVersion = parseInt(versionResult[0]?.current_version, 10);
      if (currentVersion !== this.REQUIRED_SCHEMA_VERSION) {
        return {
          ready: false,
          status: 'UNHEALTHY',
          latencyMs,
          hasPendingMigrations: false,
          schemaVersion: isNaN(currentVersion) ? null : currentVersion,
          failureReason: `Incompatible schema version: expected v${this.REQUIRED_SCHEMA_VERSION}, found v${currentVersion}`,
          timestamp,
        };
      }

      return {
        ready: true,
        status: 'HEALTHY',
        latencyMs,
        hasPendingMigrations: false,
        schemaVersion: currentVersion,
        timestamp,
      };
    } catch (err: any) {
      const sanitizedError = this.sanitizeErrorMessage(err?.message || String(err));
      this.logger.error(`Database readiness check failed: ${sanitizedError}`);

      return {
        ready: false,
        status: 'UNHEALTHY',
        latencyMs: Date.now() - start,
        hasPendingMigrations: true,
        schemaVersion: null,
        failureReason: sanitizedError,
        timestamp,
      };
    }
  }

  /**
   * Redacts sensitive database passwords or credentials from error strings.
   */
  public sanitizeErrorMessage(message: string): string {
    return message
      .replace(/password=[^\s;]+/gi, 'password=***')
      .replace(/(postgres|postgresql):\/\/[^@]+@/gi, '$1://***:***@');
  }
}

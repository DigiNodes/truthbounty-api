import { getRuntimeEnvironment } from '../config/runtime-config';
import {
  Module,
  Global,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, InjectDataSource } from '@nestjs/typeorm';
import { ModuleRef } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { DatabaseService } from './database.service';
import { TransactionRunner } from './transaction.runner';
import { TransactionHelper } from './transaction.helper';
import { DatabaseReadinessService } from './database-readiness.service';
import { MigrationValidatorService } from './migrations/migration-validator.service';
import { PoolBudgetService, PoolMetricsSink } from './pool-budget.service';
import { buildPoolConfig, buildPoolExtra } from './pool.config';
import { MetricsService } from '../metrics/metrics.service';

/**
 * DatabaseModule — PostgreSQL infrastructure for TruthBounty V2.
 *
 * Replaces the inline SQLite configuration in AppModule with a proper,
 * environment-driven PostgreSQL setup supporting:
 *
 * - PostgreSQL connectivity via `DATABASE_URL` or individual env vars
 * - Connection pooling (max connections, idle timeout, acquire timeout)
 * - SSL support for production
 * - Migration execution and rollback
 * - Repository injection pattern
 * - Transaction management via {@link TransactionRunner}
 * - Transaction helper support via {@link TransactionHelper}
 * - Health reporting via {@link DatabaseService}
 *
 * This module is **global** — every backend service can inject repositories,
 * DatabaseService, TransactionRunner, and TransactionHelper without importing
 * DatabaseModule explicitly. The TypeORM DataSource is the single source of
 * database connectivity.
 *
 * ## Environment variables
 *
 * | Variable | Default | Description |
 * |----------|---------|-------------|
 * | `DATABASE_URL` | — | Full PostgreSQL connection string (takes precedence) |
 * | `DB_HOST` | `localhost` | Database host |
 * | `DB_PORT` | `5432` | Database port |
 * | `DB_USERNAME` | `postgres` | Database user |
 * | `DB_PASSWORD` | — | Database password |
 * | `DB_DATABASE` | `truthbounty` | Database name |
 * | `DB_SSL` | `false` | Enable SSL (set to `true` in production) |
 * | `DB_POOL_MAX` | `20` | Maximum pool connections (clamped to 1–100) |
 * | `DB_POOL_MIN` | `2` | Minimum idle connections |
 * | `DB_POOL_IDLE_TIMEOUT` | derived | Idle connection timeout (ms); derived from acquire/idle-tx timeouts when unset |
 * | `DB_POOL_ACQUIRE_TIMEOUT` | `30000` | Connection acquisition timeout (ms) |
 * | `DB_STATEMENT_TIMEOUT` | `15000` | Server-side statement timeout (ms) — cancels runaway queries |
 * | `DB_IDLE_TRANSACTION_TIMEOUT` | `10000` | Server-side idle-in-transaction timeout (ms) — reclaims leaked transactions |
 * | `DB_TRANSACTION_DEADLINE` | `30000` | Application-side whole-transaction deadline (ms) |
 * | `DB_POOL_BUDGET_API` | 60% of max | Per-workload connection budget for HTTP handlers |
 * | `DB_POOL_BUDGET_JOBS` | 30% of max | Per-workload connection budget for background jobs |
 * | `DB_POOL_BUDGET_ADMIN` | 10% of max | Per-workload connection budget for admin/probes |
 * | `DB_POOL_BUDGET_DEFAULT` | 50% of max | Fallback workload budget |
 * | `DATABASE_SYNCHRONIZE` | `false` | Auto-sync schema (NEVER enable in production) |
 * | `DATABASE_LOGGING` | `false` | Enable query logging |
 *
 * All numeric values are clamped into safe ranges (fail-closed), so a
 * misconfigured environment degrades to a bounded pool instead of allowing
 * unbounded connection use.
 */
@Global()
@Module({
  providers: [
    DatabaseService,
    DatabaseReadinessService,
    MigrationValidatorService,
    PoolBudgetService,
    TransactionRunner,
    TransactionHelper,
  ],
  exports: [
    DatabaseService,
    DatabaseReadinessService,
    PoolBudgetService,
    TransactionRunner,
    TransactionHelper,
    TypeOrmModule,
  ],
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const logger = new Logger('DatabaseModule');
        const poolConfig = buildPoolConfig(getRuntimeEnvironment(), logger);
        const poolExtra = buildPoolExtra(poolConfig);

        const databaseUrl = configService.get<string>('DATABASE_URL');

        if (databaseUrl) {
          logger.log('Connecting to PostgreSQL via DATABASE_URL');
          return {
            type: 'postgres',
            url: databaseUrl,
            entities: [__dirname + '/../**/*.entity{.ts,.js}'],
            migrations: [__dirname + '/../migrations/*{.ts,.js}'],
            // NEVER synchronize in production — data loss risk
            synchronize:
              configService.get<string>('NODE_ENV') !== 'production' &&
              configService.get<string>('DATABASE_SYNCHRONIZE') === 'true',
            logging: configService.get<string>('DATABASE_LOGGING') === 'true',
            ssl:
              configService.get<string>('DB_SSL') === 'true'
                ? {
                    rejectUnauthorized:
                      configService.get('DATABASE_SSL_REJECT_UNAUTHORIZED') !==
                      'false',
                  }
                : false,
            extra: poolExtra,
          };
        }

        // Fallback: individual connection parameters
        const host = configService.get<string>('DB_HOST', 'localhost');
        const port = configService.get<number>('DB_PORT', 5432);
        const username = configService.get<string>('DB_USERNAME', 'postgres');
        const password = configService.get<string>('DB_PASSWORD', '');
        const database = configService.get<string>(
          'DB_DATABASE',
          'truthbounty',
        );
        const ssl = configService.get<string>('DB_SSL') === 'true';

        logger.log(`Connecting to PostgreSQL at ${host}:${port}/${database}`);

        return {
          type: 'postgres',
          host,
          port,
          username,
          password,
          database,
          entities: [__dirname + '/../**/*.entity{.ts,.js}'],
          migrations: [__dirname + '/../migrations/*{.ts,.js}'],
          synchronize:
            configService.get<string>('NODE_ENV') !== 'production' &&
            configService.get<string>('DATABASE_SYNCHRONIZE') === 'true',
          logging: configService.get<string>('DATABASE_LOGGING') === 'true',
          ssl: ssl ? { rejectUnauthorized: false } : false,
          extra: poolExtra,
        };
      },
    }),
  ],
})
export class DatabaseModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly moduleRef: ModuleRef,
    private readonly poolBudget: PoolBudgetService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.wireMetricsSink();
    if (this.dataSource.isInitialized) {
      this.logger.log('PostgreSQL connection pool established');
      return;
    }
    try {
      await this.dataSource.initialize();
      this.logger.log('PostgreSQL connection pool initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize PostgreSQL connection', error);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Drain budget waiters first so no request is left hanging on a
    // connection that will never be granted during teardown.
    await this.poolBudget.shutdown();
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
      this.logger.log('PostgreSQL connection pool closed');
    }
  }

  /**
   * Lazily resolves `MetricsService` and attaches it as the budget-event
   * sink. Resolved lazily (rather than via a static `import` of the metrics
   * module) to avoid a circular module dependency; if the metrics module is
   * not present (e.g. isolated unit-test context) this is a no-op.
   */
  private wireMetricsSink(): void {
    try {
      const sink = this.moduleRef.get<PoolMetricsSink>(MetricsService, {
        strict: false,
      });
      this.poolBudget.setMetricsSink(sink);
      this.logger.log('Pool budget metrics sink attached');
    } catch {
      this.logger.warn(
        'MetricsService unavailable; pool budget events will not be exported to Prometheus',
      );
    }
  }
}

import { getRuntimeEnvironment } from './runtime-config';
import {
  DataSource,
  DataSourceOptions,
  NamingStrategyInterface,
} from 'typeorm';
import { DefaultNamingStrategy } from 'typeorm/naming-strategy/DefaultNamingStrategy';
import { buildPoolConfig, buildPoolExtra } from '../database/pool.config';

class SnakeNamingStrategy
  extends DefaultNamingStrategy
  implements NamingStrategyInterface {}

/**
 * TypeORM DataSource configuration for TruthBounty V2.
 *
 * Supports both PostgreSQL (production/staging) and SQLite (development).
 * The datasource type is driven by `DATABASE_URL` (PostgreSQL) or falls back
 * to SQLite when no PostgreSQL URL is configured.
 *
 * ## Usage
 *
 * ```
 * # PostgreSQL (production)
 * DATABASE_URL=postgresql://user:pass@host:5432/truthbounty?sslmode=require
 *
 * # SQLite (local development — automatic fallback)
 * # No env vars needed
 * ```
 *
 * ## Migration commands
 *
 * ```bash
 * npm run migration:generate  # Generate a new migration
 * npm run migration:run       # Apply pending migrations
 * npm run migration:revert    # Rollback last migration
 * ```
 */
function buildOptions(): DataSourceOptions {
  const env = getRuntimeEnvironment();
  const databaseUrl = env.DATABASE_URL;

  if (databaseUrl) {
    // PostgreSQL via DATABASE_URL
    return {
      type: 'postgres',
      url: databaseUrl,
      entities: ['src/**/*.entity.ts'],
      migrations: ['src/database/migrations/*.ts'],
      subscribers: ['src/**/*.subscriber.ts'],
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false, // NEVER synchronize via CLI — use migrations
      logging: env.DATABASE_LOGGING === 'true',
      // SSL support for production
      ssl:
        env.DB_SSL === 'true' || env.DATABASE_SSL === 'true'
          ? {
              rejectUnauthorized:
                env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
            }
          : false,
      // Connection pooling, statement, and idle-transaction budgets.
      // Built by the shared factory so CLI migrations and the runtime pool
      // apply identical fail-closed bounds (pool size, acquisition timeout,
      // statement timeout, idle-in-transaction timeout).
      extra: {
        // Retry strategy (non-pg pool keys retained for compatibility)
        maxRetries: Number.parseInt(env.DB_POOL_RETRIES ?? '3', 10),
        retryDelay: Number.parseInt(env.DB_POOL_RETRY_DELAY ?? '1000', 10),
        ...buildPoolExtra(buildPoolConfig(env)),
      },
    };
  }

  // Fallback to SQLite (development)
  return {
    type: 'better-sqlite3',
    database: env.SQLITE_PATH ?? 'database.sqlite',
    entities: ['src/**/*.entity.ts'],
    migrations: ['src/database/migrations/*.ts'],
    synchronize: env.NODE_ENV !== 'production',
    logging: env.DATABASE_LOGGING === 'true',
  };
}

export const dataSource = new DataSource(buildOptions());

export default dataSource;

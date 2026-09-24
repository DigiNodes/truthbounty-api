import { DataSource, DataSourceOptions } from 'typeorm';
import { config } from 'dotenv';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

config();

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
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    // PostgreSQL via DATABASE_URL
    return {
      type: 'postgres',
      url: databaseUrl,
      entities: ['src/**/*.entity.ts'],
      migrations: ['src/migrations/*.ts'],
      subscribers: ['src/**/*.subscriber.ts'],
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false, // NEVER synchronize via CLI — use migrations
      logging: process.env.DATABASE_LOGGING === 'true',
      // SSL support for production
      ssl:
        process.env.DB_SSL === 'true' || process.env.DATABASE_SSL === 'true'
          ? {
              rejectUnauthorized:
                process.env.DB_SSL === 'true'
                  ? false
                  : process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
            }
          : false,
      // Connection pooling configuration
      extra: {
        max: parseInt(process.env.DB_POOL_MAX ?? '20', 10),
        idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT ?? '30000', 10),
        connectionTimeoutMillis: parseInt(process.env.DB_POOL_ACQUIRE_TIMEOUT ?? '60000', 10),
        // Retry strategy
        maxRetries: parseInt(process.env.DB_POOL_RETRIES ?? '3', 10),
        retryDelay: parseInt(process.env.DB_POOL_RETRY_DELAY ?? '1000', 10),
      },
    };
  }

  // Fallback to SQLite (development)
  return {
    type: 'sqlite',
    database: process.env.SQLITE_PATH ?? 'database.sqlite',
    entities: ['src/**/*.entity.ts'],
    migrations: ['src/migrations/*.ts'],
    synchronize: process.env.NODE_ENV !== 'production',
    logging: process.env.DATABASE_LOGGING === 'true',
  };
}

export const dataSource = new DataSource(buildOptions());

export default dataSource;
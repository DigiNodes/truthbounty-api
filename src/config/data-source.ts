import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

config();

/**
 * PostgreSQL DataSource configuration for TypeORM CLI and runtime.
 *
 * Uses environment variables for all connection settings to support
 * local development, staging, and production environments.
 *
 * - synchronize is ALWAYS disabled for PostgreSQL (migrations are required)
 * - SSL is enabled when DATABASE_SSL=true (production)
 * - Connection pooling is configured via extra options
 */
export const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  database: process.env.DB_NAME ?? 'truthbounty',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/migrations/*.ts'],
  subscribers: ['src/**/*.subscriber.ts'],
  namingStrategy: new SnakeNamingStrategy(),
  // Never auto-sync schema in production. Migrations are the source of truth.
  synchronize: false,
  logging: process.env.DATABASE_LOGGING === 'true',
  // Connection pooling configuration
  extra: {
    max: parseInt(process.env.DB_POOL_MAX ?? '20', 10),
    idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT ?? '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.DB_POOL_ACQUIRE_TIMEOUT ?? '10000', 10),
    // Retry strategy
    maxRetries: parseInt(process.env.DB_POOL_RETRIES ?? '3', 10),
    retryDelay: parseInt(process.env.DB_POOL_RETRY_DELAY ?? '1000', 10),
  },
  // SSL support for production
  ssl:
    process.env.DATABASE_SSL === 'true'
      ? {
          rejectUnauthorized:
            process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
        }
      : false,
});

export default dataSource;

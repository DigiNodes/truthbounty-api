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
 * Build the TypeORM CLI datasource options.
 *
 * PostgreSQL is the only supported persistence engine. Runtime and migration
 * tooling must not silently select different databases based on whether
 * DATABASE_URL happens to be present.
 */
export function buildDataSourceOptions(
  env: NodeJS.ProcessEnv = getRuntimeEnvironment(),
): DataSourceOptions {
  const databaseUrl = env.DATABASE_URL;
  const port = Number.parseInt(env.DB_PORT ?? '5432', 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DB_PORT must be an integer between 1 and 65535');
  }

  const connection = databaseUrl
    ? { url: databaseUrl }
    : {
        host: env.DB_HOST ?? 'localhost',
        port,
        username: env.DB_USERNAME ?? 'postgres',
        password: env.DB_PASSWORD ?? '',
        database: env.DB_DATABASE ?? 'truthbounty',
      };

  return {
    type: 'postgres',
    ...connection,
    entities: ['src/**/*.entity.ts'],
    migrations: ['src/migrations/*.ts'],
    subscribers: ['src/**/*.subscriber.ts'],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    logging: env.DATABASE_LOGGING === 'true',
    ssl:
      env.DB_SSL === 'true' || env.DATABASE_SSL === 'true'
        ? {
            rejectUnauthorized:
              env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
          }
        : false,
    extra: {
      maxRetries: Number.parseInt(env.DB_POOL_RETRIES ?? '3', 10),
      retryDelay: Number.parseInt(env.DB_POOL_RETRY_DELAY ?? '1000', 10),
      ...buildPoolExtra(buildPoolConfig(env)),
    },
  };
}

export const dataSource = new DataSource(buildDataSourceOptions());

export default dataSource;

import { Module, Global, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DatabaseService } from './database.service';
import { TransactionRunner } from './transaction.runner';

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
 * - Health reporting via {@link DatabaseService}
 *
 * ## Architecture
 *
 * This module is **global** — every backend service can inject repositories
 * and the transaction runner without importing DatabaseModule explicitly.
 * The TypeORM DataSource is the single source of database connectivity.
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
 * | `DB_POOL_MAX` | `20` | Maximum pool connections |
 * | `DB_POOL_IDLE_TIMEOUT` | `30000` | Idle connection timeout (ms) |
 * | `DB_POOL_ACQUIRE_TIMEOUT` | `60000` | Connection acquisition timeout (ms) |
 * | `DATABASE_SYNCHRONIZE` | `false` | Auto-sync schema (NEVER enable in production) |
 * | `DATABASE_LOGGING` | `false` | Enable query logging |
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const logger = new Logger('DatabaseModule');

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
            ssl: configService.get<string>('DB_SSL') === 'true'
              ? { rejectUnauthorized: false }
              : false,
            extra: {
              max: configService.get<number>('DB_POOL_MAX', 20),
              idleTimeoutMillis: configService.get<number>('DB_POOL_IDLE_TIMEOUT', 30000),
              connectionTimeoutMillis: configService.get<number>('DB_POOL_ACQUIRE_TIMEOUT', 60000),
            },
          };
        }

        // Fallback: individual connection parameters
        const host = configService.get<string>('DB_HOST', 'localhost');
        const port = configService.get<number>('DB_PORT', 5432);
        const username = configService.get<string>('DB_USERNAME', 'postgres');
        const password = configService.get<string>('DB_PASSWORD', '');
        const database = configService.get<string>('DB_DATABASE', 'truthbounty');
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
          extra: {
            max: configService.get<number>('DB_POOL_MAX', 20),
            idleTimeoutMillis: configService.get<number>('DB_POOL_IDLE_TIMEOUT', 30000),
            connectionTimeoutMillis: configService.get<number>('DB_POOL_ACQUIRE_TIMEOUT', 60000),
          },
        };
      },
    }),
  ],
  providers: [DatabaseService, TransactionRunner],
  exports: [DatabaseService, TransactionRunner, TypeOrmModule],
})
export class DatabaseModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
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
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
      this.logger.log('PostgreSQL connection pool closed');
    }
  }
}

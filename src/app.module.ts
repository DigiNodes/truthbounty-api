import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RewardsModule } from './rewards/rewards.module';
import blockchainConfig from './config/blockchain.config';
import sybilConfig from './config/sybil.config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlockchainModule } from './blockchain/blockchain.module';
import { DisputeModule } from './dispute/dispute.module';
import { IdentityModule } from './identity/identity.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import throttlerConfig from './config/throttler.config';
import { WalletThrottlerGuard } from './common/guards/wallet-throttler.guard';
import { SybilResistanceModule } from './sybil-resistance/sybil-resistance.module';
import { AggregationModule } from './aggregation/aggregation.module';
import { JobsModule } from './jobs/jobs.module';
import { CacheModule } from './cache/cache.module';
import { ClaimsModule } from './claims/claims.module';
import { AuditModule } from './audit/audit.module';
import { ThemeModule } from './theme.module';
import { AuditLoggingInterceptor } from './audit/interceptors/audit-logging.interceptor';
import { LoggerModule } from './logger/logger.module';
import { LoggingInterceptor } from './logger/logging.interceptor';
import { AuthModule } from './auth/auth.module';
import { GlobalAuthGuard } from './auth/global-auth.guard';
import { MetricsModule } from './metrics/metrics.module';
import { ReputationModule } from './reputation/reputation.module';
import { GovernanceModule } from './governance/governance.module';
import { AiAssistantModule } from './ai-assistant/ai-assistant.module';
import { AdminModule } from './admin/admin.module';
import { ProfilerModule } from './profiler/profiler.module';
import { ProfilerInterceptor } from './profiler/profiler.interceptor';
import { HealthModule } from './health/health.module';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { InventoryModule } from './inventory/inventory.module';

// In-memory storage for development (no Redis needed)
class ThrottlerMemoryStorage {
  private storage = new Map<
    string,
    {
      totalHits: number;
      expiresAt: number;
      blockExpiresAt: number;
      isBlocked: boolean;
    }
  >();
  private readonly logger = new Logger('ThrottlerMemoryStorage');

  constructor() {
    this.logger.log(
      'Using in-memory storage for rate limiting (development mode)',
    );
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<{
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
  }> {
    const now = Date.now();
    const record = this.storage.get(key);

    if (!record) {
      const newRecord = {
        totalHits: 1,
        expiresAt: now + ttl,
        blockExpiresAt: 0,
        isBlocked: false,
      };
      this.storage.set(key, newRecord);
      return {
        totalHits: 1,
        timeToExpire: ttl,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }

    if (record.isBlocked) {
      if (record.blockExpiresAt <= now) {
        record.isBlocked = false;
        record.totalHits = 1;
        record.expiresAt = now + ttl;
        record.blockExpiresAt = 0;
      } else {
        return {
          totalHits: record.totalHits,
          timeToExpire: Math.max(record.expiresAt - now, 0),
          isBlocked: true,
          timeToBlockExpire: Math.max(record.blockExpiresAt - now, 0),
        };
      }
    }

    if (record.expiresAt <= now) {
      record.totalHits = 1;
      record.expiresAt = now + ttl;
    } else {
      record.totalHits++;
    }

    if (record.totalHits > limit && !record.isBlocked) {
      record.isBlocked = true;
      record.blockExpiresAt = now + blockDuration;
      record.expiresAt = now + ttl;
    }

    this.storage.set(key, record);

    return {
      totalHits: record.totalHits,
      timeToExpire: Math.max(record.expiresAt - now, 0),
      isBlocked: record.isBlocked,
      timeToBlockExpire: record.isBlocked
        ? Math.max(record.blockExpiresAt - now, 0)
        : 0,
    };
  }
}

// Redis storage for production
class ThrottlerRedisStorage {
  private redis: any;
  private readonly logger = new Logger('ThrottlerRedisStorage');

  constructor(redis: any) {
    this.redis = redis;
    this.logger.log('Using Redis storage for rate limiting (production mode)');
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<{
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
  }> {
    const blockKey = `${key}:blocked`;
    const [blocked, blockTimeToExpire] = await Promise.all([
      this.redis.exists(blockKey),
      this.redis.pttl(blockKey),
    ]);

    if (blocked) {
      const timeToExpire = await this.redis.pttl(key);
      return {
        totalHits: await this.redis
          .get(key)
          .then((value: string | null) => Number(value) || limit + 1),
        timeToExpire: timeToExpire > 0 ? timeToExpire : ttl,
        isBlocked: true,
        timeToBlockExpire: blockTimeToExpire > 0 ? blockTimeToExpire : 0,
      };
    }

    const [totalHits, existingTtl] = await Promise.all([
      this.redis.incr(key),
      this.redis.pttl(key),
    ]);

    let timeToExpire = existingTtl;
    if (timeToExpire === -1 || timeToExpire === -2) {
      await this.redis.pexpire(key, ttl);
      timeToExpire = ttl;
    }

    if (totalHits > limit) {
      await Promise.all([
        this.redis.set(blockKey, '1', 'PX', blockDuration),
        this.redis.pexpire(key, blockDuration),
      ]);
      return {
        totalHits,
        timeToExpire: blockDuration,
        isBlocked: true,
        timeToBlockExpire: blockDuration,
      };
    }

    return {
      totalHits,
      timeToExpire: timeToExpire > 0 ? timeToExpire : ttl,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}

// Factory to create appropriate storage based on environment
async function createThrottlerStorage(
  configService: ConfigService,
): Promise<any> {
  const useRedis = configService.get<string>('REDIS_HOST');

  if (useRedis) {
    try {
      const Redis = (await import('ioredis')).default;
      const redisHost = configService.get<string>(
        'throttler.redis.host',
        'localhost',
      );
      const redisPort = configService.get<number>('throttler.redis.port', 6379);

      const redis = new Redis({
        host: redisHost,
        port: redisPort,
        maxRetriesPerRequest: 3,
        lazyConnect: true,
        retryStrategy: (times) => {
          if (times > 3) {
            return null; // Stop retrying
          }
          return Math.min(times * 100, 3000);
        },
      });

      // Test connection
      await redis.ping();
      return new ThrottlerRedisStorage(redis);
    } catch (error) {
      const logger = new Logger('ThrottlerModule');
      logger.warn(
        `Redis connection failed, falling back to memory storage: ${error}`,
      );
      return new ThrottlerMemoryStorage();
    }
  }

  return new ThrottlerMemoryStorage();
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [blockchainConfig, throttlerConfig, sybilConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST', 'localhost'),
        port: configService.get<number>('DB_PORT', 5432),
        username: configService.get<string>('DB_USERNAME', 'postgres'),
        password: configService.get<string>('DB_PASSWORD', 'postgres'),
        database: configService.get<string>('DB_NAME', 'truthbounty'),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        // Migrations are the source of truth. Never auto-sync schema.
        synchronize: false,
        logging: configService.get<string>('DATABASE_LOGGING') === 'true',
        // Connection pooling for high-concurrency production workloads
        extra: {
          max: configService.get<number>('DB_POOL_MAX', 20),
          idleTimeoutMillis: configService.get<number>('DB_POOL_IDLE_TIMEOUT', 30000),
          connectionTimeoutMillis: configService.get<number>('DB_POOL_ACQUIRE_TIMEOUT', 10000),
          maxRetries: configService.get<number>('DB_POOL_RETRIES', 3),
          retryDelay: configService.get<number>('DB_POOL_RETRY_DELAY', 1000),
        },
        // SSL support for production
        ssl:
          configService.get<string>('DATABASE_SSL') === 'true'
            ? {
                rejectUnauthorized:
                  configService.get<string>('DATABASE_SSL_REJECT_UNAUTHORIZED') !== 'false',
              }
            : false,
      }),
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const storage = await createThrottlerStorage(configService);
        return {
          throttlers: [
            {
              ttl: configService.get<number>('throttler.default.ttl', 60000),
              limit: configService.get<number>('throttler.default.limit', 10),
            },
          ],
          storage: storage,
        };
      },
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          password: configService.get<string>('REDIS_PASSWORD'),
          db: configService.get<number>('REDIS_DB', 0),
        },
      }),
    }),
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
    }),
    RedisModule,
    LoggerModule,
    AuthModule,
    BlockchainModule,
    DisputeModule,
    IdentityModule,
    PrismaModule,
    RewardsModule,
    SybilResistanceModule,
    AggregationModule,
    JobsModule,
    CacheModule,
    ClaimsModule,
    AuditModule,
    ThemeModule,
    MetricsModule,
    ReputationModule,
    GovernanceModule,
    AiAssistantModule,
    AdminModule,
    ProfilerModule,
    HealthModule,
    FeatureFlagsModule,
    InventoryModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: GlobalAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: WalletThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditLoggingInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ProfilerInterceptor,
    },
  ],
})
export class AppModule {}

import { getNestRuntimeConfig } from './config/runtime-config';
import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RewardsModule } from './rewards/rewards.module';
import blockchainConfig from './config/blockchain.config';
import sybilConfig from './config/sybil.config';
import finalityPolicyConfig from './config/finality-policy.config';
import { FinalityPolicyModule } from './config/finality-policy.module';
import { BlockchainModule } from './blockchain/blockchain.module';
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
import { ClaimFeedModule } from './claims/v2/claim-feed.module';
import { ClaimReadModelsModule } from './claims/v2/read-models/claim-read-models.module';
import { DisputeReadModelsModule } from './v2/disputes/read-models/dispute-read-models.module';
import { AuditModule } from './audit/audit.module';
import { ThemeModule } from './theme.module';
import { SupportModule } from './support/support.module';
import { AuditLoggingInterceptor } from './audit/interceptors/audit-logging.interceptor';
import { LoggerModule } from './logger/logger.module';
import { LoggingInterceptor } from './logger/logging.interceptor';
import { AuthModule } from './auth/auth.module';
import { GlobalAuthGuard } from './auth/global-auth.guard';
import { MetricsModule } from './metrics/metrics.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReputationModule } from './reputation/reputation.module';
import { GovernanceModule } from './governance/governance.module';
import { AiAssistantModule } from './ai-assistant/ai-assistant.module';
import { AdminModule } from './admin/admin.module';
import { V2EventsModule } from './v2/events/v2-events.module';
import { V2EvidenceModule } from './v2/evidence/v2-evidence.module';
import { V2VerificationModule } from './v2/verification/v2-verification.module';
import { V2DisputesModule } from './v2/disputes/v2-disputes.module';
import { ChainEventsModule } from './v2/chain-events/chain-events.module';
import { BlockCursorModule } from './v2/block-cursor/block-cursor.module';
import { V2RewardsModule } from './v2/rewards/v2-rewards.module';
import { V2StakingModule } from './v2/staking/v2-staking.module';
import { V2RebuildModule } from './v2/rebuild/v2-rebuild.module';
import { V2ProjectionModule } from './v2/projection/v2-projection.module';
import { ProfilerModule } from './profiler/profiler.module';
import { ProfilerInterceptor } from './profiler/profiler.interceptor';
import { HealthModule } from './health/health.module';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { RealtimeModule } from './realtime/realtime.module';
import { StakingModule } from './staking/staking.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { IdempotencyGuard } from './common/idempotency/idempotency.guard';
import { IndexerModule } from './indexer/indexer.module';
import { V2OutboxModule } from './v2/outbox/v2-outbox.module';
import { CredentialRotationModule } from './security/credential-rotation.module';
import { OperationsModule } from './operations/operations.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { GracefulShutdownModule } from './common/lifecycle/graceful-shutdown.module';
import { GracefulShutdownService } from './common/lifecycle/graceful-shutdown.service';
import { NotificationsModule as OutboundWebhooksNotificationsModule } from './notifications/notifications.module';
import { AbuseSignalsModule } from './abuse-signals/abuse-signals.module';
import { AbuseSignalInterceptor } from './abuse-signals/abuse-signal.interceptor';
import { WebhooksModule } from './webhooks/webhooks.module';

// In-memory storage for development (no Redis needed)
class ThrottlerMemoryStorage {
  private storage = new Map<string, {
    totalHits: number;
    expiresAt: number;
    blockExpiresAt: number;
    isBlocked: boolean;
  }>();
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

  async close(): Promise<void> {
    await this.redis.quit();
    this.logger.log('Rate-limit Redis connection closed');
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
      this.redis.ptl(blockKey),
    ]);

    if (blocked) {
      const timeToExpire = await this.redis.ptl(key);
      return {
        totalHits: await this.redis
          .get(key)
          .then((value: string | null) => Number(value) || limit + 1),
        timeToExpire: timeToExpire > 0 ? timeToExpire : ttl,
        isBlocked: true,
        timeToBlockExpire: blockTimeToExpire > 0 ? blockTimeToExpire : 0,
      };
    }

    const [totalHits, existingTll] = await Promise.all([
      this.redis.incr(key),
      this.redis.ptl(key),
    ]);

    let timeToExpire = existingTll;
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
): Promise<ThrottlerMemoryStorage | ThrottlerRedisStorage> {
  const useRedis = configService.get<string>('REDIS_HOST');

  if (useRedis) {
    try {
      const Redis = (await import('ioredis')).default;
      const redisHost = configService.get(
        'throttler.redis.host',
        'localhost',
      );
      const redisPort = configService.get('throttler.redis.port', 6379);

      const redis = new Redis({
        host: redisHost,
        port: redisPort,
        password: configService.get<string>('REDIS_PASSWORD'),
        db: Number(configService.get('REDIS_DB', 0)),
        tls: configService.get('REDIS_TLS') === 'true' ? {} : undefined,
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
      if (
        ['production', 'staging'].includes(
          configService.get('NODE_ENV', 'development'),
        )
      ) {
        throw new Error('Redis rate-limit storage unavailable');
      }
      const logger = new Logger('ThrottlerModule');
      logger.warn(
        `Redis connection failed, falling back to memory storage: ${error} `,
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
      load: [
        blockchainConfig,
        throttlerConfig,
        sybilConfig,
        finalityPolicyConfig,
      ],
      ignoreEnvFile: true,
      skipProcessEnv: true,
      validate: () => getNestRuntimeConfig(),
    }),
    FinalityPolicyModule,
    ScheduleModule.forRoot(),
    DiscoveryModule,
    GracefulShutdownModule,
    // Idempotency Module
    // Provides idempotency key handling for safe commands
    IdempotencyModule,
    // STAB-BE-006: Prisma/PostgreSQL is the single persistence authority.
    // The former TypoORM DatabaseModule (SQLite/PostgreSQL dual path) has
    // been removed; all repositories and transactions flow through Prisma.
    PrismaModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService, GracefulShutdownService],
      useFactory: async (
        configService: ConfigService,
        gracefulShutdown: GracefulShutdownService,
      ) => {
        const storage = await createThrottlerStorage(configService);
        if (storage instanceof ThrottlerRedisStorage) {
          gracefulShutdown.registerStopHook('throttler-redis', () =>
            storage.close(),
          );
        }
        return {
          throttlers: [
            {
              ttl: configService.get('throttler.default.ttl', 60000),
              limit: configService.get('throttler.default.limit', 10),
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
          tls: configService.get('REDIS_TLS') === 'true' ? {} : undefined,
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
    IdentityModule,
    RewardsModule,
    SybilResistanceModule,
    AggregationModule,
    JobsModule,
    CacheModule,
    ClaimsModule,
    ClaimFeedModule,
    // PREWAVE-BE-005: versioned claim list/detail read models
    ClaimReadModelsModule,
    // PREWAVE-BE-007: versioned dispute register/detail read models
    DisputeReadModelsModule,
    AuditModule,
    ThemeModule,
    SupportModule,
    MetricsModule,
    NotificationsModule,
    ReputationModule,
    GovernanceModule,
    AiAssistantModule,
    AdminModule,
    V2EventsModule,
    V2EvidenceModule,
    V2VerificationModule,
    V2DisputesModule,
    ChainEventsModule,
    BlockCursorModule,
    V2RewardsModule,
    V2StakingModule,
    V2RebuildModule,
    V2ProjectionModule,
    ProfilerModule,
    HealthModule,
    FeatureFlagsModule,
    RealtimeModule,
    StakingModule,
    IndexerModule,
    // V2-BE-113: Transactional outbox (now Prisma-backed)
    V2OutboxModule,
    CredentialRotationModule,
    // UX-BE-004 (#59
    OperationsModule,
    AbuseSignalsModule,
    // PREWAVE-BE-058: inbound webhook signature verification
    WebhooksModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    EnvironmentValidationService,
    {
      provide: APP_GUARD,
      useClass: GlobalAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: IdempotencyGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditLoggingInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: IdempotencyGuard,
    },
    {
      provide: APP_GUARD,
      useClass: WalletThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditLoggingInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ProfilerInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AbuseSignalInterceptor,
    },
  ],
})
export class AppModule {}

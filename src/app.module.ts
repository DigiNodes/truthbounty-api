import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import throttlerConfig from './config/throttler.config';
import { WalletThrottlerGuard } from './common/guards/wallet-throttler.guard';
import { SybilResistanceModule } from './sybil-resistance/sybil-resistance.module';

// In-memory storage for development (no Redis needed)
class ThrottlerMemoryStorage {
  private storage = new Map<string, { count: number; expiresAt: number }>();
  private readonly logger = new Logger('ThrottlerMemoryStorage');

  constructor() {
    this.logger.log('Using in-memory storage for rate limiting (development mode)');
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<{ totalHits: number; timeToExpire: number; isBlocked: boolean; timeToBlockExpire: number }> {
    const now = Date.now();
    const record = this.storage.get(key);

    // Clean up expired entries periodically
    if (Math.random() < 0.01) {
      this.cleanup();
    }

    if (!record || record.expiresAt < now) {
      // Key doesn't exist or expired, create new
      this.storage.set(key, { count: 1, expiresAt: now + ttl });
      return {
        totalHits: 1,
        timeToExpire: ttl,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }

    // Increment existing key
    record.count++;
    this.storage.set(key, record);

    return {
      totalHits: record.count,
      timeToExpire: record.expiresAt - now,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, value] of this.storage.entries()) {
      if (value.expiresAt < now) {
        this.storage.delete(key);
      }
    }
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
  ): Promise<{ totalHits: number; timeToExpire: number; isBlocked: boolean; timeToBlockExpire: number }> {
    const multi = this.redis.multi();
    multi.incr(key);
    multi.pttl(key);

    const results = await multi.exec();
    const totalHits = results?.[0]?.[1] as number;
    let timeToExpire = results?.[1]?.[1] as number;

    if (timeToExpire === -1) {
      await this.redis.pexpire(key, ttl);
      timeToExpire = ttl;
    }

    return {
      totalHits,
      timeToExpire,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}

// Factory to create appropriate storage based on environment
async function createThrottlerStorage(configService: ConfigService): Promise<any> {
  const useRedis = configService.get<string>('REDIS_HOST');

  if (useRedis) {
    try {
      const Redis = (await import('ioredis')).default;
      const redisHost = configService.get<string>('throttler.redis.host', 'localhost');
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
      logger.warn(`Redis connection failed, falling back to memory storage: ${error}`);
      return new ThrottlerMemoryStorage();
    }
  }

  return new ThrottlerMemoryStorage();
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [throttlerConfig],
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
    SybilResistanceModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: WalletThrottlerGuard,
    },
  ],
})
export class AppModule { }

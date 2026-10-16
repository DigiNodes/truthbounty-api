import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Span, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { TracingService } from '../tracing/tracing.service';

/**
 * Redis Service
 *
 * Provides Redis caching functionality with graceful degradation.
 * If Redis is unavailable, the service will log warnings but allow the app to continue.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private isConnected = false;

  constructor(
    private configService: ConfigService,
    private readonly tracingService: TracingService,
  ) {}

  async onModuleInit() {
    const redisEnabled =
      this.configService.get<string>('REDIS_ENABLED', 'true') === 'true';

    if (!redisEnabled) {
      this.logger.warn('Redis is disabled via configuration');
      return;
    }

    try {
      const host = this.configService.get<string>('REDIS_HOST', 'localhost');
      const port = this.configService.get<number>('REDIS_PORT', 6379);
      const password = this.configService.get<string>('REDIS_PASSWORD');
      const db = this.configService.get<number>('REDIS_DB', 0);
      const tls =
        this.configService.get<string>('REDIS_TLS', 'false') === 'true';

      this.client = new Redis({
        host,
        port,
        password,
        db,
        tls: tls ? {} : undefined,
        retryStrategy: (times) => {
          if (times > 3) {
            this.logger.error('Redis connection failed after 3 retries');
            return null; // Stop retrying
          }
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        maxRetriesPerRequest: 3,
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        this.logger.log('Redis connected successfully');
      });

      this.client.on('error', () => {
        this.isConnected = false;
        this.logger.error('Redis connection error');
      });

      this.client.on('close', () => {
        this.isConnected = false;
        this.logger.warn('Redis connection closed');
      });

      // Test connection
      await this.client.ping();
      this.logger.log(`Redis connected to ${host}:${port}`);
    } catch {
      this.logger.error('Failed to initialize Redis');
      this.logger.warn('Application will continue without Redis caching');
      this.client = null;
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit();
      this.logger.log('Redis connection closed');
    }
  }

  /**
   * Get a value from Redis
   */
  async get(key: string): Promise<string | null> {
    return this.runRedisOperation('get', async (span) => {
      if (!this.client || !this.isConnected) return null;
      try {
        return await this.client.get(key);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute(
          'error.type',
          error instanceof Error ? error.name : 'Error',
        );
        this.logger.error('Redis GET failed');
        return null;
      }
    });
  }

  /**
   * Set a value in Redis with optional TTL
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    return this.runRedisOperation('set', async (span) => {
      if (!this.client || !this.isConnected) return false;
      try {
        if (ttlSeconds) {
          await this.client.setex(key, ttlSeconds, value);
        } else {
          await this.client.set(key, value);
        }
        return true;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute(
          'error.type',
          error instanceof Error ? error.name : 'Error',
        );
        this.logger.error('Redis SET failed');
        return false;
      }
    });
  }

  /**
   * Delete a key from Redis
   */
  async del(key: string): Promise<boolean> {
    return this.runRedisOperation('del', async (span) => {
      if (!this.client || !this.isConnected) return false;
      try {
        await this.client.del(key);
        return true;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute(
          'error.type',
          error instanceof Error ? error.name : 'Error',
        );
        this.logger.error('Redis DEL failed');
        return false;
      }
    });
  }

  /**
   * Check if Redis is healthy and connected
   */
  async isHealthy(): Promise<boolean> {
    return this.runRedisOperation('ping', async (span) => {
      if (!this.client || !this.isConnected) return false;
      try {
        const result = await this.client.ping();
        return result === 'PONG';
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute(
          'error.type',
          error instanceof Error ? error.name : 'Error',
        );
        this.logger.error('Redis health check failed');
        return false;
      }
    });
  }

  /**
   * Get Redis connection status
   */
  getStatus(): { connected: boolean; enabled: boolean } {
    return {
      connected: this.isConnected,
      enabled: this.client !== null,
    };
  }

  /**
   * Get the underlying Redis client (use with caution)
   */
  getClient(): Redis | null {
    return this.client;
  }

  private runRedisOperation<T>(
    operation: string,
    callback: (span: Span) => Promise<T>,
  ): Promise<T> {
    return this.tracingService.runSpan(`redis.${operation}`, callback, {
      kind: SpanKind.CLIENT,
      attributes: {
        'db.system': 'redis',
        'db.operation.name': operation,
      },
    });
  }
}

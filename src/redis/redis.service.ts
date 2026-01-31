import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

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

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    const redisEnabled = this.configService.get<string>('REDIS_ENABLED', 'true') === 'true';
    
    if (!redisEnabled) {
      this.logger.warn('Redis is disabled via configuration');
      return;
    }

    try {
      const host = this.configService.get<string>('REDIS_HOST', 'localhost');
      const port = this.configService.get<number>('REDIS_PORT', 6379);
      const password = this.configService.get<string>('REDIS_PASSWORD');
      const db = this.configService.get<number>('REDIS_DB', 0);
      const tls = this.configService.get<string>('REDIS_TLS', 'false') === 'true';

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

      this.client.on('error', (error) => {
        this.isConnected = false;
        this.logger.error(`Redis connection error: ${error.message}`);
      });

      this.client.on('close', () => {
        this.isConnected = false;
        this.logger.warn('Redis connection closed');
      });

      // Test connection
      await this.client.ping();
      this.logger.log(`Redis connected to ${host}:${port}`);
    } catch (error) {
      this.logger.error(`Failed to initialize Redis: ${error.message}`);
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
    if (!this.client || !this.isConnected) {
      this.logger.debug(`Redis unavailable, skipping GET for key: ${key}`);
      return null;
    }

    try {
      return await this.client.get(key);
    } catch (error) {
      this.logger.error(`Redis GET error for key ${key}: ${error.message}`);
      return null;
    }
  }

  /**
   * Set a value in Redis with optional TTL
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      this.logger.debug(`Redis unavailable, skipping SET for key: ${key}`);
      return false;
    }

    try {
      if (ttlSeconds) {
        await this.client.setex(key, ttlSeconds, value);
      } else {
        await this.client.set(key, value);
      }
      return true;
    } catch (error) {
      this.logger.error(`Redis SET error for key ${key}: ${error.message}`);
      return false;
    }
  }

  /**
   * Delete a key from Redis
   */
  async del(key: string): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      this.logger.debug(`Redis unavailable, skipping DEL for key: ${key}`);
      return false;
    }

    try {
      await this.client.del(key);
      return true;
    } catch (error) {
      this.logger.error(`Redis DEL error for key ${key}: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if Redis is healthy and connected
   */
  async isHealthy(): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      this.logger.error(`Redis health check failed: ${error.message}`);
      return false;
    }
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
}

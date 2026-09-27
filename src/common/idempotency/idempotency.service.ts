import { Injectable, Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';

export interface IdempotencyResponse {
  response: any;
  status: number;
  timestamp: number;
  expires: number;
}

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly idempotencyEnabled: boolean;
  private readonly idempotencyTTL: number;
  private readonly idempotencyKeyLength: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    this.idempotencyEnabled = this.configService.get<boolean>('IDEMPOTENCY_ENABLED', true);
    this.idempotencyTTL = this.configService.get<number>('IDEMPOTENCY_TTL', 24 * 60 * 60); // 24 hours default
    this.idempotencyKeyLength = this.configService.get<number>('IDEMPOTENCY_KEY_LENGTH', 32);
  }

  /**
   * Generate a random idempotency key
   */
  generateKey(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(this.idempotencyKeyLength)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Validate an idempotency key format
   */
  validateKey(key: string): boolean {
    if (!key || typeof key !== 'string') return false;
    if (key.length < this.idempotencyKeyLength) return false;

    // Check if key contains only hexadecimal characters
    return /^[0-9a-f]+$/i.test(key);
  }

  /**
   * Store a response for an idempotency key
   */
  async storeResponse(key: string, response: any, status: number): Promise<void> {
    if (!this.idempotencyEnabled) return;

    try {
      const expires = Date.now() + this.idempotencyTTL * 1000;
      const storedResponse: IdempotencyResponse = {
        response,
        status,
        timestamp: Date.now(),
        expires,
      };

      await this.redisService.set(
        `idempotency:${key}`,
        JSON.stringify(storedResponse),
        this.idempotencyTTL
      );

      this.logger.debug(`Stored response for idempotency key: ${key}`);
    } catch (error) {
      this.logger.error(`Failed to store response for idempotency key: ${key}`, error);
      throw new InternalServerErrorException('Failed to store idempotency response');
    }
  }

  /**
   * Retrieve a response for an idempotency key
   */
  async getResponse(key: string): Promise<IdempotencyResponse | null> {
    if (!this.idempotencyEnabled) return null;

    try {
      const stored = await this.redisService.get(`idempotency:${key}`);
      if (!stored) return null;

      const response: IdempotencyResponse = JSON.parse(stored);

      // Check if the response has expired
      if (Date.now() > response.expires) {
        await this.redisService.del(`idempotency:${key}`);
        return null;
      }

      return response;
    } catch (error) {
      this.logger.error(`Failed to retrieve response for idempotency key: ${key}`, error);
      return null;
    }
  }

  /**
   * Delete an idempotency key
   */
  async deleteKey(key: string): Promise<void> {
    if (!this.idempotencyEnabled) return;

    try {
      await this.redisService.del(`idempotency:${key}`);
      this.logger.debug(`Deleted idempotency key: ${key}`);
    } catch (error) {
      this.logger.error(`Failed to delete idempotency key: ${key}`, error);
    }
  }

  /**
   * Check if idempotency is enabled
   */
  isEnabled(): boolean {
    return this.idempotencyEnabled;
  }
}

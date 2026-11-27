import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from 'crypto';
import { RedisService } from '../../redis/redis.service';
import { DeliveryChannel } from '../interfaces/notification.types';

/**
 * Custom error classes for unsubscribe token handling.
 * All errors fail closed without exposing internal cryptographic state or user data.
 */
export class UnsubscribeTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsubscribeTokenError';
  }
}

export class InvalidUnsubscribeTokenError extends UnsubscribeTokenError {
  constructor(message: string = 'Invalid or tampered unsubscribe token') {
    super(message);
    this.name = 'InvalidUnsubscribeTokenError';
  }
}

export class ExpiredUnsubscribeTokenError extends UnsubscribeTokenError {
  constructor(message: string = 'Unsubscribe token has expired') {
    super(message);
    this.name = 'ExpiredUnsubscribeTokenError';
  }
}

export class ReplayUnsubscribeTokenError extends UnsubscribeTokenError {
  constructor(message: string = 'Unsubscribe token has already been used') {
    super(message);
    this.name = 'ReplayUnsubscribeTokenError';
  }
}

/**
 * Claims cryptographically sealed inside the opaque token.
 * Never exposed over the wire in plaintext.
 */
export interface UnsubscribeTokenClaims {
  /** Unique single-use token ID (UUIDv4) for replay prevention */
  readonly tokenId: string;
  /** Recipient user ID */
  readonly userId: string;
  /** Target delivery channel (purpose-bound, e.g. EMAIL) */
  readonly channel: DeliveryChannel;
  /** Action purpose binding (must be 'unsubscribe') */
  readonly action: 'unsubscribe';
  /** Issued-at timestamp in Unix seconds */
  readonly iat: number;
  /** Expiration timestamp in Unix seconds */
  readonly exp: number;
}

export interface GenerateUnsubscribeTokenOptions {
  readonly userId: string;
  readonly channel?: DeliveryChannel;
  readonly ttlSeconds?: number;
}

export interface ConsumeUnsubscribeTokenResult {
  readonly success: boolean;
  readonly userId: string;
  readonly channel: DeliveryChannel;
  readonly tokenId: string;
}

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days bounded expiry
const TOKEN_PREFIX = 'tbunsub_';
const AAD_CONTEXT = Buffer.from('truthbounty:notification:unsubscribe:v1', 'utf8');
const IV_LENGTH = 12; // 96-bit IV for AES-256-GCM
const AUTH_TAG_LENGTH = 16; // 128-bit authentication tag
const DEV_FALLBACK_SECRET = 'truthbounty-dev-unsubscribe-secret-minimum-32-chars-long';

/**
 * UnsubscribeTokenService
 *
 * Implements cryptographically secure, opaque, single-use unsubscribe tokens
 * with bounded expiry, purpose binding, replay protection, and server-side verification.
 *
 * Security features:
 * - Confidentiality: AES-256-GCM encryption prevents leaking user IDs or metadata.
 * - Authenticity & Integrity: 128-bit GCM authentication tag prevents tampering.
 * - High Entropy: Random 96-bit IV + random 128-bit UUID payload guarantees unpredictability.
 * - Purpose Binding: Explicitly binds action ('unsubscribe') and channel (EMAIL).
 * - Bounded Expiry: Tokens expire after a configured TTL (default 7 days).
 * - Replay Protection: Single-use token ID tracked in Redis (with in-memory fallback).
 * - Observability Redaction: Raw tokens are never logged.
 */
@Injectable()
export class UnsubscribeTokenService {
  private readonly logger = new Logger(UnsubscribeTokenService.name);
  private readonly encryptionKey: Buffer;
  private readonly inMemoryReplayCache = new Map<string, number>();

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly redisService?: RedisService,
  ) {
    this.encryptionKey = this.deriveKey();
  }

  /**
   * Derive a 256-bit symmetric key for AES-256-GCM using HMAC-SHA256.
   */
  private deriveKey(): Buffer {
    const secret =
      this.configService.get<string>('UNSUBSCRIBE_TOKEN_SECRET') ||
      this.configService.get<string>('JWT_SECRET');

    const env = this.configService.get<string>('NODE_ENV', 'development');
    const isProductionOrStaging = ['production', 'staging'].includes(env);

    if (!secret) {
      if (isProductionOrStaging) {
        throw new Error(
          'Missing UNSUBSCRIBE_TOKEN_SECRET / JWT_SECRET in production/staging environment',
        );
      }
      return createHmac('sha256', DEV_FALLBACK_SECRET)
        .update('truthbounty:unsubscribe-token:v1')
        .digest();
    }

    return createHmac('sha256', secret)
      .update('truthbounty:unsubscribe-token:v1')
      .digest();
  }

  /**
   * Redacts token for safe logging and telemetry.
   */
  redactToken(token?: string | null): string {
    if (!token) return '[EMPTY_TOKEN]';
    return '[REDACTED]';
  }

  /**
   * Generate a cryptographically secure, opaque unsubscribe token.
   *
   * The token contains no readable user identifiers or timestamps.
   */
  generateToken(options: GenerateUnsubscribeTokenOptions): string {
    if (!options.userId || typeof options.userId !== 'string') {
      throw new Error('userId is required to generate unsubscribe token');
    }

    const channel = options.channel ?? DeliveryChannel.EMAIL;
    const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const now = Math.floor(Date.now() / 1000);
    const exp = now + ttlSeconds;
    const tokenId = randomUUID();

    const payload = JSON.stringify({
      tid: tokenId,
      uid: options.userId,
      ch: channel,
      act: 'unsubscribe',
      iat: now,
      exp,
    });

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(AAD_CONTEXT);

    const ciphertext = Buffer.concat([
      cipher.update(payload, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Pack: IV (12 bytes) + AuthTag (16 bytes) + Ciphertext
    const packed = Buffer.concat([iv, authTag, ciphertext]);
    return `${TOKEN_PREFIX}${packed.toString('base64url')}`;
  }

  /**
   * Verify an opaque token, checking integrity, bounds, purpose, and replay state.
   * Does NOT consume the token.
   */
  async verifyToken(tokenInput: string): Promise<UnsubscribeTokenClaims> {
    const rawToken = this.parseTokenFromUrl(tokenInput);
    if (!rawToken) {
      throw new InvalidUnsubscribeTokenError('Missing or malformed unsubscribe token');
    }

    const claims = this.decryptToken(rawToken);

    // Purpose binding checks
    if (claims.action !== 'unsubscribe') {
      throw new InvalidUnsubscribeTokenError('Invalid token purpose');
    }

    if (!Object.values(DeliveryChannel).includes(claims.channel)) {
      throw new InvalidUnsubscribeTokenError('Invalid target channel');
    }

    // Expiry check
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp <= now) {
      throw new ExpiredUnsubscribeTokenError('Unsubscribe token has expired');
    }

    // Replay check
    const isReplayed = await this.isTokenReplayed(claims.tokenId);
    if (isReplayed) {
      throw new ReplayUnsubscribeTokenError('Unsubscribe token has already been used');
    }

    return claims;
  }

  /**
   * Decrypt and validate AES-256-GCM envelope.
   */
  private decryptToken(token: string): UnsubscribeTokenClaims {
    const cleanToken = token.startsWith(TOKEN_PREFIX)
      ? token.slice(TOKEN_PREFIX.length)
      : token;

    let buffer: Buffer;
    try {
      buffer = Buffer.from(cleanToken, 'base64url');
    } catch {
      throw new InvalidUnsubscribeTokenError('Malformed token encoding');
    }

    const minLength = IV_LENGTH + AUTH_TAG_LENGTH + 1;
    if (buffer.length < minLength) {
      throw new InvalidUnsubscribeTokenError('Token payload too short');
    }

    const iv = buffer.subarray(0, IV_LENGTH);
    const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAAD(AAD_CONTEXT);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');

      const parsed = JSON.parse(decrypted);

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof parsed.tid !== 'string' ||
        typeof parsed.uid !== 'string' ||
        typeof parsed.ch !== 'string' ||
        typeof parsed.exp !== 'number' ||
        typeof parsed.iat !== 'number'
      ) {
        throw new InvalidUnsubscribeTokenError('Invalid token claims structure');
      }

      return {
        tokenId: parsed.tid,
        userId: parsed.uid,
        channel: parsed.ch as DeliveryChannel,
        action: parsed.act ?? 'unsubscribe',
        iat: parsed.iat,
        exp: parsed.exp,
      };
    } catch (err) {
      if (err instanceof UnsubscribeTokenError) {
        throw err;
      }
      throw new InvalidUnsubscribeTokenError('Invalid or tampered unsubscribe token');
    }
  }

  /**
   * Atomically verify and consume a token, marking it as used to enforce single-use / replay protection.
   */
  async consumeToken(tokenInput: string): Promise<ConsumeUnsubscribeTokenResult> {
    const claims = await this.verifyToken(tokenInput);

    const now = Math.floor(Date.now() / 1000);
    const ttlSeconds = Math.max(1, claims.exp - now);

    const markSuccess = await this.markTokenUsed(claims.tokenId, ttlSeconds);
    if (!markSuccess) {
      throw new ReplayUnsubscribeTokenError('Unsubscribe token has already been used');
    }

    this.logger.debug(
      `Unsubscribe token consumed successfully for user ${claims.userId} on channel ${claims.channel}`,
    );

    return {
      success: true,
      userId: claims.userId,
      channel: claims.channel,
      tokenId: claims.tokenId,
    };
  }

  /**
   * Check if a token ID has already been used.
   */
  private async isTokenReplayed(tokenId: string): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);

    // In-memory check first
    const inMemExp = this.inMemoryReplayCache.get(tokenId);
    if (inMemExp && inMemExp > now) {
      return true;
    }

    // Redis check
    if (this.redisService) {
      const key = `unsubscribe:replay:${tokenId}`;
      const exists = await this.redisService.get(key);
      if (exists) {
        return true;
      }
    }

    return false;
  }

  /**
   * Atomically mark a token ID as used with TTL matching remaining token lifespan.
   */
  private async markTokenUsed(tokenId: string, ttlSeconds: number): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + ttlSeconds;

    // Prune expired entries in memory cache occasionally
    if (this.inMemoryReplayCache.size > 10000) {
      for (const [id, expiry] of this.inMemoryReplayCache.entries()) {
        if (expiry <= now) {
          this.inMemoryReplayCache.delete(id);
        }
      }
    }

    // Try Redis setnx first if available
    if (this.redisService) {
      const key = `unsubscribe:replay:${tokenId}`;
      const setSuccess = await this.redisService.setnx(key, '1', ttlSeconds);
      if (!setSuccess) {
        return false;
      }
    }

    // In-memory set
    if (this.inMemoryReplayCache.has(tokenId)) {
      const existingExp = this.inMemoryReplayCache.get(tokenId)!;
      if (existingExp > now) {
        return false;
      }
    }

    this.inMemoryReplayCache.set(tokenId, exp);
    return true;
  }

  /**
   * Safely extract a token from a raw string, path, or URL without throwing.
   * Fails closed by returning null on malformed, oversized, or invalid inputs.
   */
  parseTokenFromUrl(input?: string | null): string | null {
    if (!input || typeof input !== 'string') {
      return null;
    }

    const trimmed = input.trim();
    if (trimmed.length === 0 || trimmed.length > 4096) {
      return null;
    }

    // If input is directly a token
    if (trimmed.startsWith(TOKEN_PREFIX)) {
      return this.sanitizeTokenString(trimmed);
    }

    // Try parsing as full URL
    try {
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        const url = new URL(trimmed);
        // Check query param ?token=...
        const queryToken = url.searchParams.get('token');
        if (queryToken) {
          return this.sanitizeTokenString(queryToken);
        }

        // Check path /unsubscribe/:token
        const pathSegments = url.pathname.split('/').filter(Boolean);
        const lastSegment = pathSegments[pathSegments.length - 1];
        if (lastSegment && lastSegment.length >= 20) {
          return this.sanitizeTokenString(lastSegment);
        }
      } else if (trimmed.startsWith('/')) {
        // Relative path e.g. /unsubscribe/:token or /unsubscribe?token=...
        const parsedUrl = new URL(trimmed, 'https://truthbounty.io');
        const queryToken = parsedUrl.searchParams.get('token');
        if (queryToken) {
          return this.sanitizeTokenString(queryToken);
        }
        const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
        const lastSegment = pathSegments[pathSegments.length - 1];
        if (lastSegment && lastSegment.length >= 20) {
          return this.sanitizeTokenString(lastSegment);
        }
      }
    } catch {
      // Invalid URL syntax fails closed safely
      return null;
    }

    // Raw base64url token string without prefix
    if (/^[A-Za-z0-9_-]{28,}$/.test(trimmed)) {
      return trimmed;
    }

    return null;
  }

  private sanitizeTokenString(token: string): string | null {
    const clean = token.trim();
    // Validate character set (prefix + base64url chars)
    if (/^(?:tbunsub_)?[A-Za-z0-9_-]{28,}$/.test(clean)) {
      return clean;
    }
    return null;
  }
}

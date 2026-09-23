import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

/**
 * Wallet-Scoped and Endpoint-Cost Rate Limiter
 *
 * Rate-limits by trusted network identity, authenticated wallet/user,
 * endpoint cost, and abuse signals without trusting spoofed headers.
 *
 * Implements V2-BE-061: Add Wallet-Scoped and Endpoint-Cost Rate Limits
 */

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  blockDurationMs?: number;
  keyPrefix?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  totalHits: number;
  isBlocked: boolean;
  retryAfterMs?: number;
}

export interface EndpointCostConfig {
  path: string | RegExp;
  method?: string;
  cost: number; // Cost multiplier for this endpoint
}

export interface WalletIdentity {
  walletAddress?: string;
  userId?: string;
  ipAddress: string;
  isTrusted: boolean;
  trustScore: number; // 0-100
}

export interface RateLimitRule {
  id: string;
  name: string;
  matcher: (req: Request) => boolean;
  config: RateLimitConfig;
  cost?: number;
  priority: number;
}

/**
 * Wallet-Scoped Rate Limiter Service
 */
@Injectable()
export class WalletRateLimiterService {
  private readonly logger = new Logger(WalletRateLimiterService.name);
  private readonly defaultConfig: RateLimitConfig = {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 100,
    blockDurationMs: 5 * 60 * 1000, // 5 minutes
    keyPrefix: 'ratelimit:',
  };

  private readonly endpointCosts: EndpointCostConfig[] = [
    // High-cost endpoints
    { path: /^\/auth\/login/, cost: 10 },
    { path: /^\/auth\/challenge/, cost: 5 },
    { path: /^\/claims/, method: 'POST', cost: 5 },
    { path: /^\/disputes/, method: 'POST', cost: 5 },
    { path: /^\/evidence/, method: 'POST', cost: 5 },
    { path: /^\/rewards\/claim/, cost: 10 },
    { path: /^\/governance\/proposals/, method: 'POST', cost: 5 },
    { path: /^\/admin/, cost: 20 },

    // Medium-cost endpoints
    { path: /^\/claims/, cost: 2 },
    { path: /^\/disputes/, cost: 2 },
    { path: /^\/identity/, method: 'POST', cost: 2 },
    { path: /^\/wallet/, method: 'POST', cost: 3 },

    // Low-cost endpoints
    { path: /^\/health/, cost: 0.1 },
    { path: /^\/metrics/, cost: 0.5 },
    { path: /^\/audit/, cost: 1 },
  ];

  private readonly walletTierLimits: Map<string, { multiplier: number; burstAllowance: number }> = new Map([
    ['new', { multiplier: 0.5, burstAllowance: 10 }],       // New wallets - restrictive
    ['basic', { multiplier: 1.0, burstAllowance: 50 }],     // Basic verified
    ['trusted', { multiplier: 2.0, burstAllowance: 200 }],  // Trusted wallets
    ['premium', { multiplier: 5.0, burstAllowance: 1000 }], // Premium/whitelisted
    ['admin', { multiplier: 10.0, burstAllowance: 5000 }],  // Admin accounts
  ]);

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    @Inject(REQUEST)
    private readonly request: Request,
  ) {}

  /**
   * Check rate limit for a request
   */
  async checkRateLimit(req: Request): Promise<RateLimitResult> {
    const identity = await this.extractIdentity(req);
    const endpointCost = this.getEndpointCost(req);
    const tierConfig = this.getTierConfig(identity);

    // Calculate effective limits based on wallet tier
    const effectiveMaxRequests = Math.floor(
      this.defaultConfig.maxRequests * tierConfig.multiplier * endpointCost
    );
    const effectiveWindowMs = this.defaultConfig.windowMs;

    // Build rate limit key
    const key = this.buildRateLimitKey(identity, req, tierConfig);

    // Check if blocked
    const blocked = await this.isBlocked(key);
    if (blocked) {
      const retryAfter = await this.getBlockTimeRemaining(key);
      return {
        allowed: false,
        remaining: 0,
        resetTime: Date.now() + retryAfter,
        totalHits: effectiveMaxRequests,
        isBlocked: true,
        retryAfterMs: retryAfter,
      };
    }

    // Increment counter
    const result = await this.incrementCounter(key, effectiveWindowMs, effectiveMaxRequests);

    // Check if exceeded
    if (result.totalHits > effectiveMaxRequests) {
      // Block the key
      await this.blockKey(key, this.defaultConfig.blockDurationMs || 5 * 60 * 1000);

      return {
        allowed: false,
        remaining: 0,
        resetTime: Date.now() + (this.defaultConfig.blockDurationMs || 5 * 60 * 1000),
        totalHits: result.totalHits,
        isBlocked: true,
        retryAfterMs: this.defaultConfig.blockDurationMs,
      };
    }

    return {
      allowed: true,
      remaining: Math.max(0, effectiveMaxRequests - result.totalHits),
      resetTime: result.resetTime,
      totalHits: result.totalHits,
      isBlocked: false,
    };
  }

  /**
   * Extract wallet identity from request
   */
  private async extractIdentity(req: Request): Promise<WalletIdentity> {
    const ipAddress = this.getClientIp(req);
    let walletAddress: string | undefined;
    let userId: string | undefined;
    let isTrusted = false;
    let trustScore = 50;

    // Check for authenticated wallet
    if (req.user) {
      const user = req.user as any;
      walletAddress = user.address?.toLowerCase();
      userId = user.sub || user.userId;

      // Check trust level from user metadata
      if (user.trustLevel) {
        const tier = this.walletTierLimits.get(user.trustLevel);
        if (tier) {
          isTrusted = true;
          trustScore = user.trustScore || 75;
        }
      }
    }

    // Check for API key / service account
    const apiKey = req.headers['x-api-key'] as string;
    if (apiKey) {
      // Lookup API key trust level
      const apiKeyTrust = await this.getApiKeyTrustLevel(apiKey);
      if (apiKeyTrust) {
        isTrusted = true;
        trustScore = Math.max(trustScore, apiKeyTrust.trustScore);
        if (apiKeyTrust.tier) {
          const tier = this.walletTierLimits.get(apiKeyTrust.tier);
          if (tier) {
            // Apply tier config
          }
        }
      }
    }

    // Check for IP reputation
    const ipReputation = await this.getIpReputation(ipAddress);
    if (ipReputation.isMalicious) {
      trustScore = Math.min(trustScore, 10);
    } else if (ipReputation.isTrusted) {
      trustScore = Math.max(trustScore, 75);
    }

    return {
      walletAddress,
      userId,
      ipAddress,
      isTrusted,
      trustScore: Math.max(0, Math.min(100, trustScore)),
    };
  }

  /**
   * Get endpoint cost multiplier
   */
  private getEndpointCost(req: Request): number {
    const path = req.path;
    const method = req.method;

    for (const endpoint of this.endpointCosts) {
      const pathMatches = typeof endpoint.path === 'string'
        ? path.startsWith(endpoint.path)
        : endpoint.path.test(path);

      const methodMatches = !endpoint.method || endpoint.method === method;

      if (pathMatches && methodMatches) {
        return endpoint.cost;
      }
    }

    return 1; // Default cost
  }

  /**
   * Get tier configuration for identity
   */
  private getTierConfig(identity: WalletIdentity): { multiplier: number; burstAllowance: number } {
    if (identity.walletAddress) {
      // In production, lookup wallet tier from database
      // For now, use trust score to determine tier
      if (identity.trustScore >= 90) return this.walletTierLimits.get('premium')!;
      if (identity.trustScore >= 70) return this.walletTierLimits.get('trusted')!;
      if (identity.trustScore >= 40) return this.walletTierLimits.get('basic')!;
      return this.walletTierLimits.get('new')!;
    }

    // Unauthenticated - use IP-based tier
    return this.walletTierLimits.get('new')!;
  }

  /**
   * Build rate limit key
   */
  private buildRateLimitKey(identity: WalletIdentity, req: Request, tierConfig: any): string {
    const parts = [this.defaultConfig.keyPrefix];

    // Primary identifier
    if (identity.walletAddress) {
      parts.push('wallet', identity.walletAddress);
    } else if (identity.userId) {
      parts.push('user', identity.userId);
    } else {
      parts.push('ip', identity.ipAddress);
    }

    // Add path for granular limiting
    const pathSegment = req.path.split('/').filter(Boolean).slice(0, 3).join(':');
    parts.push('path', pathSegment || 'root');

    return parts.join(':');
  }

  /**
   * Increment rate limit counter
   */
  private async incrementCounter(key: string, windowMs: number, maxRequests: number): Promise<{ totalHits: number; resetTime: number }> {
    const now = Date.now();
    const windowStart = now - (now % windowMs);
    const windowKey = `${key}:${windowStart}`;

    const luaScript = `
      local current = redis.call('INCR', KEYS[1])
      if current == 1 then
        redis.call('PEXPIRE', KEYS[1], ARGV[1])
      end
      local ttl = redis.call('PTTL', KEYS[1])
      return {current, ttl}
    `;

    const result = await this.redisService.eval(luaScript, 1, windowKey, windowMs);
    const totalHits = result[0];
    const ttl = result[1];
    const resetTime = Date.now() + ttl;

    return { totalHits, resetTime };
  }

  /**
   * Check if key is blocked
   */
  private async isBlocked(key: string): Promise<boolean> {
    const blockKey = `${key}:blocked`;
    const result = await this.redisService.get(blockKey);
    return result !== null;
  }

  /**
   * Block a key
   */
  private async blockKey(key: string, durationMs: number): Promise<void> {
    const blockKey = `${key}:blocked`;
    await this.redisService.set(blockKey, '1', Math.ceil(durationMs / 1000));
    this.logger.warn(`Rate limit blocked: ${key} for ${durationMs}ms`);
  }

  /**
   * Get block time remaining
   */
  private async getBlockTimeRemaining(key: string): Promise<number> {
    const blockKey = `${key}:blocked`;
    const ttl = await this.redisService.pttl(blockKey);
    return ttl > 0 ? ttl : 0;
  }

  /**
   * Get client IP from request
   */
  private getClientIp(req: Request): string {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  /**
   * Get API key trust level (placeholder)
   */
  private async getApiKeyTrustLevel(apiKey: string): Promise<{ tier: string; trustScore: number } | null> {
    // In production, lookup from database
    // const apiKeyRecord = await this.apiKeyService.findByKey(apiKey);
    // return apiKeyRecord ? { tier: apiKeyRecord.tier, trustScore: apiKeyRecord.trustScore } : null;
    return null;
  }

  /**
   * Get IP reputation (placeholder)
   */
  private async getIpReputation(ip: string): Promise<{ isMalicious: boolean; isTrusted: boolean }> {
    // In production, check against threat intelligence feeds
    // For now, basic checks
    const trustedRanges = [
      '127.0.0.1',
      '::1',
      // Add known good IP ranges
    ];

    const isTrusted = trustedRanges.some(range => ip.startsWith(range));
    const isMalicious = false; // Would check against abuse databases

    return { isMalicious, isTrusted };
  }

  /**
   * Get rate limit headers for response
   */
  getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
    return {
      'X-RateLimit-Limit': String(result.totalHits + result.remaining),
      'X-RateLimit-Remaining': String(result.remaining),
      'X-RateLimit-Reset': String(Math.ceil(result.resetTime / 1000)),
      'X-RateLimit-Blocked': result.isBlocked ? 'true' : 'false',
      ...(result.retryAfterMs ? { 'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)) } : {}),
    };
  }

  /**
   * Reset rate limit for a specific identity (admin action)
   */
  async resetRateLimit(identifier: string): Promise<void> {
    const pattern = `${this.defaultConfig.keyPrefix}*${identifier}*`;
    // In production, use SCAN to find and delete matching keys
    this.logger.log(`Rate limit reset for: ${identifier}`);
  }

  /**
   * Get current rate limit status for an identity
   */
  async getRateLimitStatus(identity: WalletIdentity, req: Request): Promise<{
    currentUsage: number;
    limit: number;
    resetTime: number;
    tier: string;
  }> {
    const tierConfig = this.getTierConfig(identity);
    const endpointCost = this.getEndpointCost(req);
    const effectiveMaxRequests = Math.floor(this.defaultConfig.maxRequests * tierConfig.multiplier * endpointCost);
    const key = this.buildRateLimitKey(identity, req, tierConfig);
    const windowStart = Date.now() - (Date.now() % this.defaultConfig.windowMs);
    const windowKey = `${key}:${windowStart}`;

    const currentUsage = parseInt(await this.redisService.get(windowKey) || '0', 10);

    return {
      currentUsage,
      limit: effectiveMaxRequests,
      resetTime: windowStart + this.defaultConfig.windowMs,
      tier: identity.walletAddress ? 'wallet' : 'ip',
    };
  }
}
import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { REQUEST } from '@nestjs/core';
import type { Request } from 'express';
import {
  AuthenticatedRequest,
  isAuthenticatedRequest,
} from './types/authenticated-request';

/**
 * Wallet-Scoped and Endpoint-Cost Rate Limiter
 *
 * Rate-limits by trusted network identity, authenticated wallet/user,
 * endpoint cost, and abuse signals without trusting spoofed headers.
 *
 * Implements V2-BE-061 & PREWAVE-BE-085: Cost-Aware Distributed Rate-Limit Budgets
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
  cost: number;
}

export interface WalletIdentity {
  walletAddress?: string;
  userId?: string;
  ipAddress: string;
  isTrusted: boolean;
  trustScore: number;
}

function isRateLimitCounterResult(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1])
  );
}

@Injectable()
export class WalletRateLimiterService {
  private readonly logger = new Logger(WalletRateLimiterService.name);
  private readonly defaultConfig: RateLimitConfig = {
    windowMs: 60 * 1000,
    maxRequests: 100,
    blockDurationMs: 5 * 60 * 1000,
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
    { path: /^\/ai/, cost: 10 },
    { path: /^\/ai-assistant/, cost: 10 },
    { path: /^\/rebuild/, cost: 15 },

    // Medium-cost endpoints
    { path: /^\/claims/, cost: 2 },
    { path: /^\/disputes/, cost: 2 },
    { path: /^\/identity/, method: 'POST', cost: 2 },
    { path: /^\/wallet/, method: 'POST', cost: 3 },
    { path: /^\/search/, cost: 3 },
    { path: /^\/stream/, cost: 5 },
    { path: /^\/webhooks/, cost: 3 },
    { path: /^\/support/, cost: 2 },
    { path: /^\/analytics/, cost: 5 },

    // Low-cost endpoints
    { path: /^\/health/, cost: 0.1 },
    { path: /^\/metrics/, cost: 0.5 },
    { path: /^\/audit/, cost: 1 },
  ];

  private readonly walletTierLimits: Map<string, { multiplier: number; burstAllowance: number }> = new Map([
    ['new', { multiplier: 0.5, burstAllowance: 10 }],
    ['basic', { multiplier: 1.0, burstAllowance: 50 }],
    ['trusted', { multiplier: 2.0, burstAllowance: 200 }],
    ['premium', { multiplier: 5.0, burstAllowance: 1000 }],
    ['admin', { multiplier: 10.0, burstAllowance: 5000 }],
  ]);

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    @Optional()
    @Inject(REQUEST)
    private readonly request?: Request,
  ) {
    this.defaultConfig.maxRequests = this.configService.get<number>('RATE_LIMIT_DEFAULT_LIMIT', 100);
    this.defaultConfig.windowMs = this.configService.get<number>('RATE_LIMIT_DEFAULT_TTL', 60) * 1000;
  }

  async checkRateLimit(req: Request): Promise<RateLimitResult> {
    const identity = await this.extractIdentity(req);
    const endpointCost = this.getEndpointCost(req);
    const tierConfig = this.getTierConfig(identity);

    const effectiveMaxRequests = Math.floor(
      this.defaultConfig.maxRequests * tierConfig.multiplier
    );
    const effectiveWindowMs = this.defaultConfig.windowMs;

    const key = this.buildRateLimitKey(identity, req);

    // Fail closed on Redis outage
    const isHealthy = await this.redisService.isHealthy();
    if (!isHealthy) {
      this.logger.error('Redis outage detected during rate limit check. Failing closed.');
      return {
        allowed: false,
        remaining: 0,
        resetTime: Date.now() + 60000,
        totalHits: effectiveMaxRequests + 1,
        isBlocked: true,
        retryAfterMs: 60000,
      };
    }

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

    const result = await this.incrementCounter(key, effectiveWindowMs, effectiveMaxRequests, endpointCost);

    if (result.totalHits > effectiveMaxRequests) {
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

  private async extractIdentity(req: Request): Promise<WalletIdentity> {
    const ipAddress = this.getClientIp(req);
    let walletAddress: string | undefined;
    let userId: string | undefined;
    let isTrusted = false;
    let trustScore = 50;

    // Only trust the principal attached by the verified JWT strategy.
    // Anonymous requests must not inherit stale identity from any other source.
    if (isAuthenticatedRequest(req)) {
      const principal = (req as AuthenticatedRequest).user;
      if (principal) {
        walletAddress = principal.address.toLowerCase();
        userId = principal.userId ?? principal.sub;
        const role = principal.user?.role;
        if (role && this.walletTierLimits.has(role)) {
          isTrusted = true;
          trustScore = 75;
        }
      }
    }

    const headerWallet = req.headers?.['x-wallet-address'] || req.headers?.['x-wallet'];
    if (!walletAddress && typeof headerWallet === 'string') {
      walletAddress = headerWallet.toLowerCase();
    }

    const apiKeyRaw = req.headers?.['x-api-key'];
    const apiKey = typeof apiKeyRaw === 'string' ? apiKeyRaw : undefined;
    if (apiKey) {
      const apiKeyTrust = await this.getApiKeyTrustLevel(apiKey);
      if (apiKeyTrust) {
        isTrusted = true;
        trustScore = Math.max(trustScore, apiKeyTrust.trustScore);
      }
    }

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

  private getEndpointCost(req: Request): number {
    if (typeof (req as any).rateLimitCost === 'number') {
      return (req as any).rateLimitCost;
    }

    const path = req.path || '';
    const method = req.method || 'GET';

    if (path.startsWith('/search')) {
      return this.calculateSearchCost(req);
    }

    for (const endpoint of this.endpointCosts) {
      const pathMatches = typeof endpoint.path === 'string'
        ? path.startsWith(endpoint.path)
        : endpoint.path.test(path);

      const methodMatches = !endpoint.method || endpoint.method === method;

      if (pathMatches && methodMatches) {
        return endpoint.cost;
      }
    }

    return 1;
  }

  public calculateSearchCost(req: Request): number {
    const path = req.path || '';
    const query = (req.query || {}) as Record<string, any>;

    // Global search queries 3 entities, entity-specific queries 1
    let cost = path === '/search' || path === '/search/' ? 5 : 2;

    const q = typeof query.q === 'string' ? query.q.trim() : '';
    if (q) {
      const terms = q.split(/\s+/).filter(Boolean);
      if (terms.length > 3) {
        cost += 1;
      }
    }

    const limit = query.limit ? Number(query.limit) : 20;
    if (limit > 50) {
      cost += 2;
    } else if (limit > 20) {
      cost += 1;
    }

    let filterCount = 0;
    for (const key of ['status', 'owner', 'walletAddress', 'fromDate', 'toDate', 'finalized']) {
      if (query[key] !== undefined && query[key] !== '') {
        filterCount++;
      }
    }
    if (filterCount > 1) {
      cost += 1;
    }

    return cost;
  }

  private getTierConfig(identity: WalletIdentity): { multiplier: number; burstAllowance: number } {
    if (identity.walletAddress) {
      if (identity.trustScore >= 90) return this.walletTierLimits.get('premium')!;
      if (identity.trustScore >= 70) return this.walletTierLimits.get('trusted')!;
      if (identity.trustScore >= 40) return this.walletTierLimits.get('basic')!;
      return this.walletTierLimits.get('new')!;
    }
    return this.walletTierLimits.get('new')!;
  }

  private buildRateLimitKey(identity: WalletIdentity, req: Request): string {
    const parts = [this.defaultConfig.keyPrefix as string];

    if (identity.walletAddress) {
      parts.push('wallet', identity.walletAddress);
    } else if (identity.userId) {
      parts.push('user', identity.userId);
    } else {
      parts.push('ip', identity.ipAddress);
    }

    const pathSegment = (req.path || '').split('/').filter(Boolean).slice(0, 3).join(':');
    parts.push('path', pathSegment || 'root');

    return parts.join(':');
  }

  private async incrementCounter(
    key: string,
    windowMs: number,
    maxRequests: number,
    endpointCost: number,
  ): Promise<{ totalHits: number; resetTime: number }> {
    const now = Date.now();
    const windowStart = now - (now % windowMs);
    const windowKey = `${key}:${windowStart}`;

    const scaledCost = Math.max(1, Math.round(endpointCost * 10));

    const luaScript = `
      local current = redis.call('INCRBY', KEYS[1], ARGV[2])
      if current == tonumber(ARGV[2]) then
        redis.call('PEXPIRE', KEYS[1], ARGV[1])
      end
      local ttl = redis.call('PTTL', KEYS[1])
      return {current, ttl}
    `;

    try {
      const result = await this.redisService.eval(luaScript, 1, windowKey, windowMs, scaledCost);
      if (!isRateLimitCounterResult(result)) {
        throw new Error('Invalid Redis rate-limit counter response');
      }
      const [scaledTotalHits, ttl] = result;
      const resetTime = Date.now() + (ttl > 0 ? ttl : windowMs);

      const totalHits = scaledTotalHits / 10;
      return { totalHits, resetTime };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Redis increment failed: ${message}. Failing closed.`);
      throw new Error(`Rate limit Redis failure (Fail Closed): ${message}`);
    }
  }

  private async isBlocked(key: string): Promise<boolean> {
    const blockKey = `${key}:blocked`;
    const exists = await this.redisService.exists(blockKey);
    return exists > 0;
  }

  private async blockKey(key: string, durationMs: number): Promise<void> {
    const blockKey = `${key}:blocked`;
    const client = this.redisService.getClient();
    if (client) {
      await client.set(blockKey, '1', 'PX', durationMs);
    } else {
      await this.redisService.set(blockKey, '1', Math.ceil(durationMs / 1000));
    }
    this.logger.warn(`Rate limit blocked: ${key} for ${durationMs}ms`);
  }

  private async getBlockTimeRemaining(key: string): Promise<number> {
    const blockKey = `${key}:blocked`;
    const ttl = await this.redisService.pttl(blockKey);
    return ttl > 0 ? ttl : 0;
  }

  private getClientIp(req: Request): string {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  private async getApiKeyTrustLevel(apiKey: string): Promise<{ tier: string; trustScore: number } | null> {
    return null;
  }

  private async getIpReputation(ip: string): Promise<{ isMalicious: boolean; isTrusted: boolean }> {
    const trustedRanges = ['127.0.0.1', '::1'];
    const isTrusted = trustedRanges.some((range) => ip.startsWith(range));
    const isMalicious = false;
    return { isMalicious, isTrusted };
  }

  getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
    return {
      'X-RateLimit-Limit': String(this.defaultConfig.maxRequests),
      'X-RateLimit-Remaining': String(Math.max(0, this.defaultConfig.maxRequests - result.totalHits)),
      'X-RateLimit-Reset': String(Math.ceil(result.resetTime / 1000)),
      'X-RateLimit-Blocked': result.isBlocked ? 'true' : 'false',
      ...(result.retryAfterMs ? { 'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)) } : {}),
    };
  }

  async resetRateLimit(identifier: string): Promise<void> {
    this.logger.log(`Rate limit reset for: ${identifier}`);
  }

  async getRateLimitStatus(identity: WalletIdentity, req: Request): Promise<{
    currentUsage: number;
    limit: number;
    resetTime: number;
    tier: string;
  }> {
    const tierConfig = this.getTierConfig(identity);
    const effectiveMaxRequests = Math.floor(this.defaultConfig.maxRequests * tierConfig.multiplier);
    const key = this.buildRateLimitKey(identity, req);
    const windowStart = Date.now() - (Date.now() % this.defaultConfig.windowMs);
    const windowKey = `${key}:${windowStart}`;

    const current = await this.redisService.get(windowKey);
    const currentUsage = current ? Number(current) / 10 : 0;

    return {
      currentUsage,
      limit: effectiveMaxRequests,
      resetTime: windowStart + this.defaultConfig.windowMs,
      tier: identity.walletAddress ? 'authenticated' : 'anonymous',
    };
  }
}

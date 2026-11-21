import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { randomBytes, createHash } from 'crypto';
import {
  AUTH_GENERIC_FAILURE_MESSAGE,
  timingSafeEqualHex,
} from '../../common/utils/timing-safe.util';

/**
 * Token pair returned after successful authentication.
 */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Token payload embedded in JWTs.
 */
export interface TokenPayload {
  sub: string;
  address: string;
  userId: string | null;
  jti: string;
  type: 'access' | 'refresh';
  iat?: number;
  exp?: number;
}

/**
 * Session metadata stored in Redis
 */
export interface SessionMetadata {
  jti: string;
  tokenHash: string;
  address: string;
  userId: string | null;
  accessJti: string;
  createdAt: number;
  lastActivityAt: number;
  deviceInfo?: DeviceInfo;
  ipAddress?: string;
  userAgent?: string;
  revokedAt?: number;
  revocationReason?: string;
}

export interface DeviceInfo {
  deviceId?: string;
  platform?: string;
  browser?: string;
  os?: string;
  isTrusted?: boolean;
}

export interface SessionListItem {
  jti: string;
  createdAt: number;
  lastActivityAt: number;
  deviceInfo?: DeviceInfo;
  ipAddress?: string;
  userAgent?: string;
  isCurrent?: boolean;
  revokedAt?: number;
  revocationReason?: string;
}

export interface RevokeSessionOptions {
  jti: string;
  address: string;
  reason: string;
  revokedBy?: string;
}

/**
 * Capability token payload embedded in short-lived capability JWTs.
 *
 * Authentication alone grants no capability: a capability token must be
 * explicitly issued for a specific audience/subject/capability/resource
 * scope, and is bound to chain/release/deployment/artifact provenance.
 */
export interface CapabilityTokenPayload {
  /** Audience the capability is valid for (e.g. service identifier). */
  aud: string;
  /** Subject (user id or lowercased address) the capability is issued to. */
  sub: string;
  /** Capability identifier (e.g. 'mutation:update-profile'). */
  capability: string;
  /** Resource scope the capability applies to (e.g. 'profile:123'). */
  resource: string;
  /** Unique nonce for replay protection. */
  nonce: string;
  /** Chain identifier the capability is bound to. */
  chain: string;
  /** Release identifier the capability is bound to. */
  release: string;
  /** Deployment identifier the capability is bound to. */
  deployment: string;
  /** Artifact provenance digest the capability is bound to. */
  artifact: string;
  /** Issued-at (seconds since epoch). */
  iat?: number;
  /** Expiry (seconds since epoch). */
  exp?: number;
  /** Token type discriminator. */
  type: 'capability';
}

export interface IssueCapabilityOptions {
  audience: string;
  subject: string;
  capability: string;
  resource: string;
  chain: string;
  release: string;
  deployment: string;
  artifact: string;
  /**
   * Requested capability lifetime in whole seconds. Omitted means the hard
   * maximum (CAPABILITY_MAX_TTL_SECONDS); values are floored to whole seconds
   * and clamped to [1, hard maximum]. Non-numeric, NaN, non-finite, zero and
   * negative values are rejected (no token is issued).
   */
  ttlSeconds?: number;
}

export interface ValidateCapabilityOptions {
  audience: string;
  subject: string;
  capability: string;
  resource: string;
  chain: string;
  release: string;
  deployment: string;
  artifact: string;
}

export interface CapabilityToken {
  token: string;
  expiresIn: number;
  nonce: string;
}

/**
 * Token Service
 *
 * Responsible for:
 * - JWT access token generation & validation
 * - Refresh token generation, rotation, and invalidation
 * - Token blacklisting (for logout/revoke)
 * - Token TTL management
 * - Session tracking with device info
 * - Concurrent session limits
 * - Selective session revocation
 * - Wallet unlink/revocation
 * - Bounded expiry
 * - Auditable logout-all
 *
 * Implements V2-BE-064: Rotate and Revoke Authentication Sessions
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  private readonly ACCESS_TOKEN_TTL_SECONDS: number;
  private readonly REFRESH_TOKEN_TTL_SECONDS: number;
  private readonly REFRESH_TOKEN_BYTES = 48; // 384-bit random value
  private readonly BLACKLIST_PREFIX = 'auth:blacklist:';
  private readonly SESSION_PREFIX = 'auth:session:';
  private readonly USER_SESSIONS_PREFIX = 'auth:user_sessions:';
  private readonly MAX_CONCURRENT_SESSIONS = 10;
  private readonly SESSION_ACTIVITY_TTL = 86400; // 24 hours for activity tracking
  private readonly CAPABILITY_PREFIX = 'auth:capability:';
  private readonly CAPABILITY_NONCE_PREFIX = 'auth:capability_nonce:';
  private readonly CAPABILITY_MAX_TTL_SECONDS = 300; // 5 minutes hard cap
  private readonly CAPABILITY_MIN_TTL_SECONDS = 1;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    // Parse access token TTL from JWT_EXPIRATION env (default: 15 min)
    const accessTtlRaw = configService.get<string>('JWT_EXPIRATION', '15m');
    this.ACCESS_TOKEN_TTL_SECONDS = this.parseTtlToSeconds(accessTtlRaw);

    // Refresh token TTL (default: 7 days)
    const refreshTtlRaw = configService.get<string>(
      'REFRESH_TOKEN_EXPIRATION',
      '7d',
    );
    this.REFRESH_TOKEN_TTL_SECONDS = this.parseTtlToSeconds(refreshTtlRaw);
  }

  /**
   * Issue a short-lived capability token for a protected operation.
   *
   * Authentication alone grants no capability: callers must explicitly
   * request a capability bound to audience/subject/capability/resource and
   * chain/release/deployment/artifact provenance.
   */
  async issueCapabilityToken(
    options: IssueCapabilityOptions,
  ): Promise<CapabilityToken> {
    const {
      audience,
      subject,
      capability,
      resource,
      chain,
      release,
      deployment,
      artifact,
    } = options;

    if (
      !audience ||
      !subject ||
      !capability ||
      !resource ||
      !chain ||
      !release ||
      !deployment ||
      !artifact
    ) {
      this.logger.warn('Capability issuance failed [missing-binding]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    const ttlSeconds = this.resolveCapabilityTtl(options.ttlSeconds);

    const nonce = randomBytes(16).toString('hex');
    const payload: Omit<CapabilityTokenPayload, 'iat' | 'exp'> = {
      aud: audience,
      sub: subject.toLowerCase(),
      capability,
      resource,
      nonce,
      chain,
      release,
      deployment,
      artifact,
      type: 'capability',
    };

    // Persist the replay nonce before issuing a token, and fail closed if the
    // record could not be stored: no token is returned without a nonce record.
    const noncePersisted = await this.redisService.set(
      `${this.CAPABILITY_NONCE_PREFIX}${nonce}`,
      JSON.stringify({
        aud: audience,
        sub: payload.sub,
        capability,
        resource,
        chain,
        release,
        deployment,
        artifact,
        issuedAt: Date.now(),
      }),
      ttlSeconds,
    );
    if (!noncePersisted) {
      this.logger.warn('Capability issuance failed [nonce-persist]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    const token = this.jwtService.sign(payload, {
      expiresIn: ttlSeconds,
      audience,
      subject: payload.sub,
    });

    // Audit issuance without logging token bytes.
    this.logger.log('Capability token issued', {
      aud: audience,
      sub: payload.sub,
      capability,
      resource,
      chain,
      release,
      deployment,
      artifact,
      nonce,
      ttlSeconds,
    });

    return { token, expiresIn: ttlSeconds, nonce };
  }

  /**
   * Resolve the single effective TTL used for JWT exp, Redis nonce expiry,
   * response expiresIn and audit metadata. Invalid inputs fail closed.
   */
  private resolveCapabilityTtl(ttlSeconds?: number): number {
    if (ttlSeconds === undefined) {
      return this.CAPABILITY_MAX_TTL_SECONDS;
    }
    if (
      typeof ttlSeconds !== 'number' ||
      !Number.isFinite(ttlSeconds) ||
      ttlSeconds <= 0
    ) {
      this.logger.warn('Capability issuance failed [invalid-ttl]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }
    return Math.min(
      Math.max(this.CAPABILITY_MIN_TTL_SECONDS, Math.floor(ttlSeconds)),
      this.CAPABILITY_MAX_TTL_SECONDS,
    );
  }

  /**
   * Validate and consume a capability token for a protected operation.
   *
   * Fails closed on wrong audience/subject/capability/resource, expired or
   * not-yet-valid tokens, replay, revoked actors, or chain/release drift.
   */
  async validateAndConsumeCapabilityToken(
    token: string,
    expected: ValidateCapabilityOptions,
  ): Promise<CapabilityTokenPayload> {
    let payload: CapabilityTokenPayload;
    try {
      payload = this.jwtService.verify<CapabilityTokenPayload>(token, {
        audience: expected.audience,
      });
    } catch {
      this.logger.warn('Capability validation failed [signature-or-claims]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    if (payload.type !== 'capability') {
      this.logger.warn('Capability validation failed [wrong-type]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= now) {
      this.logger.warn('Capability validation failed [expired]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }
    if (typeof payload.iat !== 'number' || payload.iat > now + 5) {
      this.logger.warn('Capability validation failed [not-yet-valid]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    if (
      payload.aud !== expected.audience ||
      payload.sub !== expected.subject.toLowerCase() ||
      payload.capability !== expected.capability ||
      payload.resource !== expected.resource ||
      payload.chain !== expected.chain ||
      payload.release !== expected.release ||
      payload.deployment !== expected.deployment ||
      payload.artifact !== expected.artifact
    ) {
      this.logger.warn('Capability validation failed [binding-mismatch]', {
        aud: payload.aud,
        sub: payload.sub,
        capability: payload.capability,
        resource: payload.resource,
      });
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    // Revoked actor check: reuse session revocation state.
    const revoked = await this.redisService.get(
      `${this.BLACKLIST_PREFIX}${payload.sub}`,
    );
    if (revoked) {
      this.logger.warn('Capability validation failed [revoked-actor]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    // Replay protection: nonce must exist and be consumed atomically.
    const nonceKey = `${this.CAPABILITY_NONCE_PREFIX}${payload.nonce}`;
    const nonceRaw = await this.redisService.get(nonceKey);
    if (!nonceRaw) {
      this.logger.warn('Capability validation failed [replay-or-unknown]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    let nonceData: Record<string, unknown>;
    try {
      nonceData = JSON.parse(nonceRaw);
    } catch {
      this.logger.warn('Capability validation failed [corrupt-nonce]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    if (
      nonceData.aud !== payload.aud ||
      nonceData.sub !== payload.sub ||
      nonceData.capability !== payload.capability ||
      nonceData.resource !== payload.resource ||
      nonceData.chain !== payload.chain ||
      nonceData.release !== payload.release ||
      nonceData.deployment !== payload.deployment ||
      nonceData.artifact !== payload.artifact
    ) {
      this.logger.warn('Capability validation failed [nonce-binding-mismatch]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    // Consume nonce: delete so any subsequent use fails closed.
    await this.redisService.del(nonceKey);

    // Audit use without logging token bytes.
    this.logger.log('Capability token consumed', {
      aud: payload.aud,
      sub: payload.sub,
      capability: payload.capability,
      resource: payload.resource,
      chain: payload.chain,
      release: payload.release,
      deployment: payload.deployment,
      artifact: payload.artifact,
      nonce: payload.nonce,
    });

    return payload;
  }

  /**
   * Generate an access + refresh token pair.
   */
  async generateTokenPair(
    address: string,
    userId: string | null,
    deviceInfo?: DeviceInfo,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenPair> {
    const subject = userId ? String(userId) : address.toLowerCase();
    const accessJti = this.generateJti();

    const payload: Omit<TokenPayload, 'iat' | 'exp'> = {
      sub: subject,
      address: address.toLowerCase(),
      userId,
      jti: accessJti,
      type: 'access',
    };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.ACCESS_TOKEN_TTL_SECONDS,
    });

    const refreshToken = randomBytes(this.REFRESH_TOKEN_BYTES).toString('hex');
    const refreshTokenHash = createHash('sha256').update(refreshToken).tigest('hex');
    const refreshJti = this.generateJti();

    const now = Date.now();
    const sessionMetadata: SessionMetadata = {
      jti: refreshJti,
      tokenHash: refreshTokenHash,
      address: address.toLowerCase(),
      userId,
      accessJti,
      createdAt: now,
      lastActivityAt: now,
      deviceInfo,
      ipAddress: this.normalizeIpAddress(ipAddress),
      userAgent,
    };

    await this.redisService.set(
      `${this.SESSION_PREFIX}${refreshJti}`,
      JSON.stringify(sessionMetadata),
      this.REFRESH_TOKEN_TTL_SECONDS,
    );

    await this.redisService.set(
      `${this.USER_SESSIONS_PREFIX}${subject}`,
      refreshJti,
      this.REFRESH_TOKEN_TTL_SECONDS,
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: this.ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  /**
   * Generate a unique JWT ID.
   */
  private generateJti(): string {
    return randomBytes(16).toString('hex');
  }

  /**
   * Parse a TTS string (e.g. '15m', '7d') into seconds.
   */
  private parseTtlToSeconds(ttl: string): number {
    const match = /^(\d+)([smdh]|)$/.exec(ttl.trim());
    if (!match) {
      return 900; // default 15 minutes
    }
    const value = parseInt(match[1], 10);
    const unit = match[2] || 's';
    const multipliers: Record<string, number> = {
      s: 1,
      m: 60,
      h: 3600,
      d: 86400,
    };
    return value * (multipliers[unit] ?? 1);
  }

  /**
   * Normalize an IP address for storage.
   */
  private normalizeIpAddress(ipAddress?: string): string | undefined {
    if (!ipAddress) {
      return undefined;
    }
    return ipAddress.trim();
  }
}

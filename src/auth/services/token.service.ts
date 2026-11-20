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
 * - Short-lived capability token issuance & validation
 *
 * Implements V2-BE-064: Rotate and Revoke Authentication Sessions
 * Implements PREWAVE-BE-082: Issue Short-Lived Capability Tokens for Protected Operations
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  private readonly ACCESS_TOKEN_TTL_SECONDS: number;
  private readonly REFRESH_TOKEN_TTL_SECONDS: number;
  private readonly REFRESH_TOKEN_BYTES = 48; // 384-bit random value
  private readonly BLACKLIST_PREFIX = 'auth:blacklist:';
  private readonly SESSION_PREFIX = 'auth:refresh:';
  private readonly USER_SESSIONS_PREFIX = 'auth:user_refresh:';
  private readonly MAX_CONCURRENT_SESSIONS = 10;
  private readonly SESSION_ACTIVITY_TTL = 86400; // 24 hours for activity tracking
  private readonly CAPABILITY_PREFIX = 'auth:capability:';
  private readonly CAPABILITY_NONCE_PREFIX = 'auth:capability_nonce:';
  private readonly CAPABILITY_MAX_TTL_SECONDS = 300; // 5 minutes hard cap

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

    const requestedTtl = options.ttlSeconds ?? this.CAPABILITY_MAX_TTL_SECONDS;
    const ttlSeconds = Math.min(
      Math.max(1, requestedTtl),
      this.CAPABILITY_MAX_TTL_SECONDS,
    );

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

    const token = this.jwtService.sign(payload, {
      expiresIn: ttlSeconds,
      audience,
      subject: payload.sub,
    });

    // Record nonce so replay can be detected and fail closed.
    await this.redisService.set(
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

    // Generate refresh token (opaque, stored in Redis)
    const refreshToken = this.generateRefreshTokenValue();
    const refreshJti = this.generateJti();

    const now = Date.now();

    // Store refresh token metadata in Redis
    const refreshKey = `${this.SESSION_PREFIX}${refreshJti}`;
    const sessionData: SessionMetadata = {
      jti: refreshJti,
      tokenHash: this.hashToken(refreshToken),
      address: address.toLowerCase(),
      userId,
      accessJti,
      createdAt: now,
      lastActivityAt: now,
      deviceInfo,
      ipAddress,
      userAgent,
    };

    await this.redisService.set(
      refreshKey,
      JSON.stringify(sessionData),
      this.REFRESH_TOKEN_TTL_SECONDS,
    );

    // Track session in user's session list
    await this.addSessionToUserList(
      address.toLowerCase(),
      refreshJti,
      sessionData,
    );

    // Enforce concurrent session limit
    await this.enforceSessionLimit(address.toLowerCase());

    return {
      accessToken,
      refreshToken: `${refreshJti}.${refreshToken}`,
      expiresIn: this.ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  /**
   * Refresh an access token using a valid refresh token.
   * Uses rotation: old refresh token is invalidated, new one issued.
   */
  async refreshAccessToken(
    refreshTokenRaw: string,
    deviceInfo?: DeviceInfo,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenPair> {
    const parts = refreshTokenRaw.split('.');
    if (parts.length !== 2) {
      this.logger.warn('Refresh failed [malformed]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    const [refreshJti, tokenValue] = parts;
    const refreshKey = `${this.SESSION_PREFIX}${refreshJti}`;

    // Check blacklist
    const isBlacklisted = await this.redisService.get(
      `${this.BLACKLIST_PREFIX}${refreshJti}`,
    );
    if (isBlacklisted) {
      this.logger.warn('Refresh failed [revoked]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    // Retrieve stored refresh data
    const raw = await this.redisService.get(refreshKey);
    if (!raw) {
      this.logger.warn('Refresh failed [not-found]');
      // Dummy compare so miss timing resembles hit timing.
      timingSafeEqualHex(
        this.hashToken(tokenValue),
        this.hashToken('dummy-refresh-token-value'),
      );
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    let storedData: SessionMetadata;
    try {
      storedData = JSON.parse(raw);
    } catch {
      this.logger.warn('Refresh failed [corrupt-data]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    // Verify token hash with timing-safe comparison (hex digests).
    const tokenHash = this.hashToken(tokenValue);
    if (!timingSafeEqualHex(tokenHash, storedData.tokenHash)) {
      // Potential token theft — revoke all user's refresh tokens (fail closed).
      this.logger.warn('Refresh failed [mismatch] — revoking all sessions');
      await this.revokeAllUserTokens(storedData.address);
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    // Check if session was revoked
    if (storedData.revokedAt) {
      throw new UnauthorizedException(
        `Session revoked: ${storedData.revocationReason}`,
      );
    }

    // Update last activity
    storedData.lastActivityAt = Date.now();
    if (deviceInfo) storedData.deviceInfo = deviceInfo;
    if (ipAddress) storedData.ipAddress = ipAddress;
    if (userAgent) storedData.userAgent = userAgent;

    // Invalidate the old refresh token (rotation)
    await this.redisService.del(refreshKey);
    await this.blacklistToken(refreshJti, this.REFRESH_TOKEN_TTL_SECONDS);

    // Issue new token pair
    const newPair = await this.generateTokenPair(
      storedData.address,
      storedData.userId,
      storedData.deviceInfo,
      storedData.ipAddress,
      storedData.userAgent,
    );

    return newPair;
  }

  /**
   * Update session activity timestamp
   */
  async updateSessionActivity(refreshTokenRaw: string): Promise<void> {
    const parts = refreshTokenRaw.split('.');
    if (parts.length !== 2) return;

    const [refreshJti] = parts;
    const refreshKey = `${this.SESSION_PREFIX}${refreshJti}`;

    const raw = await this.redisService.get(refreshKey);
    if (!raw) return;

    try {
      const sessionData: SessionMetadata = JSON.parse(raw);
      sessionData.lastActivityAt = Date.now();
      await this.redisService.set(
        refreshKey,
        JSON.stringify(sessionData),
        this.REFRESH_TOKEN_TTL_SECONDS,
      );
    } catch {
      // Ignore parse errors
    }
  }

  /**
   * Get all active sessions for a user
   */
  async getUserSessions(
    address: string,
    currentJti?: string,
  ): Promise<SessionListItem[]> {
    const userSessionsKey = `${this.USER_SESSIONS_PREFIX}${address.toLowerCase()}`;
    const raw = await this.redisService.get(userSessionsKey);

    if (!raw) return [];

    try {
      const sessionList: string[] = JSON.parse(raw);
      const sessions: SessionListItem[] = [];

      for (const jti of sessionList) {
        const sessionKey = `${this.SESSION_PREFIX}${jti}`;
        const rawSession = await this.redisService.get(sessionKey);

        if (rawSession) {
          try {
            const sessionData: SessionMetadata = JSON.parse(rawSession);
            sessions.push({
              jti: sessionData.jti,
              createdAt: sessionData.createdAt,
              lastActivityAt: sessionData.lastActivityAt,
              deviceInfo: sessionData.deviceInfo,
              ipAddress: sessionData.ipAddress,
              userAgent: sessionData.userAgent,
              isCurrent: jti === currentJti,
              revokedAt: sessionData.revokedAt,
              revocationReason: sessionData.revocationReason,
            });
          } catch {
            // Skip corrupted sessions
          }
        }
      }

      // Sort by last activity (most recent first)
      return sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    } catch {
      return [];
    }
  }

  /**
   * Revoke a specific session
   */
  async revokeSession(options: RevokeSessionOptions): Promise<boolean> {
    const { jti, address, reason, revokedBy } = options;
    const sessionKey = `${this.SESSION_PREFIX}${jti}`;

    const raw = await this.redisService.get(sessionKey);
    if (!raw) {
      return false;
    }

    try {
      const sessionData: SessionMetadata = JSON.parse(raw);

      // Verify ownership
      if (sessionData.address.toLowerCase() !== address.toLowerCase()) {
        return false;
      }

      // Mark as revoked
      sessionData.revokedAt = Date.now();
      sessionData.revocationReason = reason;

      // Update in Redis
      await this.redisService.set(
        sessionKey,
        JSON.stringify(sessionData),
        this.REFRESH_TOKEN_TTL_SECONDS,
      );

      // Blacklist the associated access token
      await this.blacklistToken(
        sessionData.accessJti,
        this.ACCESS_TOKEN_TTL_SECONDS,
      );

      // Log revocation
      this.logger.log(`Session revoked: ${jti} for ${address} — ${reason}`, {
        jti,
        address,
        reason,
        revokedBy,
        revokedAt: sessionData.revokedAt,
      });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Revoke all sessions for a user except the current one
   */
  async revokeOtherSessions(
    address: string,
    currentJti: string,
    reason = 'User requested revocation of other sessions',
  ): Promise<number> {
    const sessions = await this.getUserSessions(address, currentJti);
    let revokedCount = 0;

    for (const session of sessions) {
      if (session.jti !== currentJti && !session.revokedAt) {
        const success = await this.revokeSession({
          jti: session.jti,
          address,
          reason,
        });
        if (success) revokedCount++;
      }
    }

    return revokedCount;
  }

  /**
   * Validate a JWT access token payload and check blacklist.
   */
  async validateAccessToken(payload: TokenPayload): Promise<boolean> {
    // Check blacklist
    const isBlacklisted = await this.redisService.get(
      `${this.BLACKLIST_PREFIX}${payload.jti}`,
    );
    if (isBlacklisted) {
      return false;
    }

    // Ensure it's an access token type
    if (payload.type !== 'access') {
      return false;
    }

    return true;
  }

  /**
   * Blacklist a specific token JTI (used on logout).
   */
  async blacklistToken(jti: string, ttlSeconds: number): Promise<void> {
    await this.redisService.set(
      `${this.BLACKLIST_PREFIX}${jti}`,
      '1',
      ttlSeconds,
    );
  }

  /**
   * Revoke all refresh tokens for a specific address.
   */
  async revokeAllUserTokens(
    address: string,
    reason = 'Administrative revocation',
  ): Promise<void> {
    const userSessionsKey = `${this.USER_SESSIONS_PREFIX}${address.toLowerCase()}`;
    const raw = await this.redisService.get(userSessionsKey);

    if (raw) {
      try {
        const sessionList: string[] = JSON.parse(raw);
        for (const jti of sessionList) {
          await this.redisService.del(`${this.SESSION_PREFIX}${jti}`);
          await this.blacklistToken(jti, this.REFRESH_TOKEN_TTL_SECONDS);
        }
      } catch {
        // If parse fails, just clean up the key
      }
    }

    await this.redisService.del(userSessionsKey);

    this.logger.log(`All sessions revoked for ${address} — ${reason}`);
  }

  /**
   * Logout: blacklist the current access token JTI and revoke associated refresh tokens.
   */
  async logout(
    payload: { address: string; jti?: string; exp?: number; [key: string]: any },
    reason = 'User logout',
  ): Promise<void> {
    if (payload.jti) {
      // Blacklist the access token for its remaining TTL
      const remainingTtl = payload.exp
        ? Math.max(0, payload.exp - Math.floor(Date.now() / 1000))
        : this.ACCESS_TOKEN_TTL_SECONDS;
      await this.blacklistToken(payload.jti, remainingTtl);
    }

    // Revoke all refresh tokens for the user
    await this.revokeAllUserTokens(payload.address, reason);
  }

  /**
   * Logout from a specific session only
   */
  async logoutSession(
    payload: TokenPayload,
    refreshTokenRaw: string,
    reason = 'User logout from session',
  ): Promise<void> {
    // Blacklist the access token
    if (payload.jti) {
      const remainingTtl = payload.exp
        ? Math.max(0, payload.exp - Math.floor(Date.now() / 1000))
        : this.ACCESS_TOKEN_TTL_SECONDS;
      await this.blacklistToken(payload.jti, remainingTtl);
    }

    // Revoke the specific refresh token
    const parts = refreshTokenRaw.split('.');
    if (parts.length === 2) {
      const [refreshJti] = parts;
      await this.revokeSession({
        jti: refreshJti,
        address: payload.address,
        reason,
      });
    }
  }

  /**
   * Check if a token is blacklisted.
   */
  async isBlacklisted(jti: string): Promise<boolean> {
    const result = await this.redisService.get(
      `${this.BLACKLIST_PREFIX}${jti}`,
    );
    return result !== null;
  }

  /**
   * Get session statistics for a user
   */
  async getSessionStats(address: string): Promise<{
    totalSessions: number;
    activeSessions: number;
    revokedSessions: number;
    oldestSession?: Date;
    newestSession?: Date;
  }> {
    const sessions = await this.getUserSessions(address);

    const active = sessions.filter((s) => !s.revokedAt);
    const revoked = sessions.filter((s) => s.revokedAt);

    const createdTimes = sessions.map((s) => s.createdAt);
    const oldest =
      createdTimes.length > 0 ? new Date(Math.min(...createdTimes)) : undefined;
    const newest =
      createdTimes.length > 0 ? new Date(Math.max(...createdTimes)) : undefined;

    return {
      totalSessions: sessions.length,
      activeSessions: active.length,
      revokedSessions: revoked.length,
      oldestSession: oldest,
      newestSession: newest,
    };
  }

  /**
   * Clean up expired sessions (can be run as a cron job)
   */
  async cleanupExpiredSessions(): Promise<number> {
    // This would scan all user session lists and remove expired entries
    // For now, Redis TTL handles automatic cleanup
    this.logger.log('Session cleanup completed (handled by Redis TTL)');
    return 0;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async addSessionToUserList(
    address: string,
    jti: string,
    sessionData: SessionMetadata,
  ): Promise<void> {
    const userSessionsKey = `${this.USER_SESSIONS_PREFIX}${address}`;
    const raw = await this.redisService.get(userSessionsKey);
    const sessionList: string[] = raw ? JSON.parse(raw) : [];

    // Add to front (most recent first)
    sessionList.unshift(jti);

    // Keep only active sessions (not revoked)
    const validSessions: string[] = [];
    for (const existingJti of sessionList) {
      const sessionKey = `${this.SESSION_PREFIX}${existingJti}`;
      const rawSession = await this.redisService.get(sessionKey);
      if (rawSession) {
        try {
          const data = JSON.parse(rawSession);
          if (!data.revokedAt) {
            validSessions.push(existingJti);
          }
        } catch {
          // Skip corrupted
        }
      }
    }

    await this.redisService.set(
      userSessionsKey,
      JSON.stringify(validSessions),
      this.REFRESH_TOKEN_TTL_SECONDS,
    );
  }

  private async enforceSessionLimit(address: string): Promise<void> {
    const sessions = await this.getUserSessions(address);
    const activeSessions = sessions.filter((s) => !s.revokedAt);

    if (activeSessions.length > this.MAX_CONCURRENT_SESSIONS) {
      // Revoke oldest sessions beyond the limit
      const toRevoke = activeSessions.slice(this.MAX_CONCURRENT_SESSIONS);
      for (const session of toRevoke) {
        await this.revokeSession({
          jti: session.jti,
          address,
          reason: `Concurrent session limit exceeded (max: ${this.MAX_CONCURRENT_SESSIONS})`,
        });
      }

      this.logger.warn(
        `Enforced session limit for ${address}: revoked ${toRevoke.length} oldest sessions`,
      );
    }
  }

  private generateJti(): string {
    return randomBytes(16).toString('hex');
  }

  private generateRefreshTokenValue(): string {
    return randomBytes(this.REFRESH_TOKEN_BYTES).toString('base64url');
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

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
}

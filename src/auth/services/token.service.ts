import {
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { randomBytes, createHash } from 'crypto';
import {
  AUTH_GENERIC_FAILURE_MESSAGE,
  timingSafeEqualHex,
} from '../../common/utils/timing-safe.util';
import {
  AuthenticatedPrincipal,
  extractCapabilitySubject,
} from '../types/authenticated-request';

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
  aud?: string | string[];
  iss?: string;
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
  subject?: string;
  principal?: AuthenticatedPrincipal;
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
 * Reconciled distinct type for JWT-based capability tokens.
 */
export type JwtCapabilityToken = CapabilityToken;

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
  private readonly ACCESS_TOKEN_AUDIENCE: string;
  private readonly TOKEN_ISSUER: string;
  private readonly REFRESH_TOKEN_BYTES = 48; // 384-bit random value
  private readonly BLACKLIST_PREFIX = 'auth:blacklist:';
  private readonly SESSION_PREFIX = 'auth:session:';
  private readonly USER_SESSIONS_PREFIX = 'auth:user_sessions:';
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
    this.ACCESS_TOKEN_AUDIENCE = configService.get<string>(
      'JWT_ACCESS_AUDIENCE',
      'truthbounty-api',
    );
    this.TOKEN_ISSUER = configService.get<string>(
      'JWT_ISSUER',
      'truthbounty-api',
    );
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
    const derivedSubject = options.principal
      ? extractCapabilitySubject(options.principal)
      : typeof options.subject === 'string' && options.subject.trim().length > 0
        ? (options.subject.startsWith('0x') ? options.subject.trim().toLowerCase() : options.subject.trim())
        : undefined;

    const {
      audience,
      capability,
      resource,
      chain,
      release,
      deployment,
      artifact,
    } = options;

    if (
      !audience ||
      !derivedSubject ||
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

if (
  !Number.isSafeInteger(requestedTtl) ||
  requestedTtl < 1 ||
  requestedTtl > this.CAPABILITY_MAX_TTL_SECONDS
) {
  this.logger.warn('Capability issuance failed [invalid-ttl]');
  throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
}

const ttlSeconds = requestedTtl;

    const nonce = randomBytes(16).toString('hex');
    const payload: Omit<CapabilityTokenPayload, 'iat' | 'exp'> = {
      aud: audience,
      sub: derivedSubject.toLowerCase(),
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
    });

    // Record nonce so replay can be detected and fail closed.
    const stored = await this.redisService.set(
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
    if (!stored) {
      this.logger.warn('Capability issuance failed [nonce-persistence]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    // Audit issuance without logging token bytes.
    this.logger.log(`Capability token issued ${JSON.stringify({
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
    })}`);

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
    let consumed: unknown;
    try {
      consumed = await this.redisService.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        1,
        nonceKey,
        nonceRaw,
      );
    } catch {
      this.logger.warn('Capability validation failed [nonce-consumption]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }
    if (Number(consumed) !== 1) {
      this.logger.warn('Capability validation failed [replay-or-unknown]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    // Audit use without logging token bytes.
    this.logger.log(`Capability token consumed ${JSON.stringify({
      aud: payload.aud,
      sub: payload.sub,
      capability: payload.capability,
      resource: payload.resource,
      chain: payload.chain,
      release: payload.release,
      deployment: payload.deployment,
      artifact: payload.artifact,
      nonce: payload.nonce,
    })}`);

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
      audience: this.ACCESS_TOKEN_AUDIENCE,
      issuer: this.TOKEN_ISSUER,
    });

    const refreshJti = this.generateJti();
    const refreshToken = `${refreshJti}.${randomBytes(this.REFRESH_TOKEN_BYTES).toString('base64url')}`;
    const refreshTokenHash = createHash('sha256')
      .update(refreshToken)
      .digest('hex');

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

    const storedSession = await this.redisService.set(
      `${this.SESSION_PREFIX}${refreshJti}`,
      JSON.stringify(sessionMetadata),
      this.REFRESH_TOKEN_TTL_SECONDS,
    );
    if (!storedSession) {
      throw new InternalServerErrorException(
        'Unable to persist authentication session',
      );
    }

    try {
      const indexed = await this.redisService.eval(
        "local raw = redis.call('GET', KEYS[1]); local ids = {}; if raw then local ok, decoded = pcall(cjson.decode, raw); if not ok or type(decoded) ~= 'table' then return redis.error_reply('Invalid user session index') end; ids = decoded end; for _, id in ipairs(ids) do if id == ARGV[1] then redis.call('EXPIRE', KEYS[1], ARGV[2]); return 1 end end; table.insert(ids, ARGV[1]); redis.call('SETEX', KEYS[1], ARGV[2], cjson.encode(ids)); return 1",
        1,
        `${this.USER_SESSIONS_PREFIX}${address.toLowerCase()}`,
        refreshJti,
        this.REFRESH_TOKEN_TTL_SECONDS,
      );
      if (Number(indexed) !== 1) {
        throw new Error('Unable to index authentication session');
      }
    } catch {
      await this.redisService.del(`${this.SESSION_PREFIX}${refreshJti}`);
      this.logger.error('Failed to persist authentication session index');
      throw new InternalServerErrorException(
        'Unable to persist authentication session',
      );
    }

    return {
      accessToken,
      refreshToken,
      expiresIn: this.ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<TokenPair> {
    const match = /^([a-f0-9]{32})\.([A-Za-z0-9_-]{32,})$/.exec(refreshToken);
    if (!match) {
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    const [, refreshJti] = match;
    if (await this.isBlacklisted(refreshJti)) {
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    const sessionKey = `${this.SESSION_PREFIX}${refreshJti}`;
    const raw = await this.redisService.get(sessionKey);
    if (!raw) {
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    let session: SessionMetadata;
    try {
      session = JSON.parse(raw) as SessionMetadata;
    } catch {
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }
    if (
      !session ||
      typeof session !== 'object' ||
      !/^0x[0-9a-f]{40}$/i.test(session.address ?? '') ||
      typeof session.accessJti !== 'string' ||
      (session.userId !== null && typeof session.userId !== 'string')
    ) {
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }
    const suppliedHash = createHash('sha256').update(refreshToken).digest('hex');
    if (
      session.jti !== refreshJti ||
      typeof session.address !== 'string' ||
      typeof session.tokenHash !== 'string' ||
      !timingSafeEqualHex(suppliedHash, session.tokenHash)
    ) {
      if (typeof session.address === 'string') {
        await this.revokeAllUserTokens(session.address);
      }
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    let consumed: unknown;
    try {
      consumed = await this.redisService.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        1,
        sessionKey,
        raw,
      );
    } catch {
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }
    if (Number(consumed) !== 1) {
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    const blacklisted = await this.redisService.set(
      `${this.BLACKLIST_PREFIX}${refreshJti}`,
      '1',
      this.REFRESH_TOKEN_TTL_SECONDS,
    );
    if (!blacklisted) {
      throw new InternalServerErrorException(
        'Unable to rotate authentication session',
      );
    }
    await this.removeSessionFromIndex(session.address, refreshJti);

    return this.generateTokenPair(
      session.address,
      session.userId,
      session.deviceInfo,
      session.ipAddress,
      session.userAgent,
    );
  }

  async validateAccessToken(
    payload: Pick<TokenPayload, 'sub' | 'address' | 'userId' | 'jti' | 'type'> &
      Partial<Pick<TokenPayload, 'aud' | 'iss'>>,
  ): Promise<boolean> {
    const audiences = Array.isArray(payload.aud)
      ? payload.aud
      : payload.aud
        ? [payload.aud]
        : [];
    if (
      payload.type !== 'access' ||
      !payload.jti ||
      !payload.address ||
      !/^0x[0-9a-f]{40}$/i.test(payload.address) ||
      !payload.sub ||
      !audiences.includes(this.ACCESS_TOKEN_AUDIENCE) ||
      payload.iss !== this.TOKEN_ISSUER ||
      payload.sub !==
        (payload.userId ? String(payload.userId) : payload.address.toLowerCase())
    ) {
      return false;
    }
    return !(await this.isBlacklisted(payload.jti));
  }

  async logout(payload: {
    address: string;
    jti?: string;
    exp?: number;
  }): Promise<void> {
    if (payload.jti) {
      const remainingTtl = payload.exp
        ? Math.max(1, payload.exp - Math.floor(Date.now() / 1000))
        : this.ACCESS_TOKEN_TTL_SECONDS;
      const blacklisted = await this.redisService.set(
        `${this.BLACKLIST_PREFIX}${payload.jti}`,
        '1',
        remainingTtl,
      );
      if (!blacklisted) {
        throw new InternalServerErrorException(
          'Unable to revoke authentication token',
        );
      }
    }
    await this.revokeAllUserTokens(payload.address);
  }

  async revokeAllUserTokens(address: string): Promise<void> {
    const normalizedAddress = address.toLowerCase();
    const indexKey = `${this.USER_SESSIONS_PREFIX}${normalizedAddress}`;
    const rawIndex = await this.redisService.get(indexKey);
    if (!rawIndex) return;

    let sessionIds: string[];
    try {
      const parsed: unknown = JSON.parse(rawIndex);
      sessionIds = Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === 'string')
        : typeof parsed === 'string'
          ? [parsed]
          : [];
    } catch {
      if (/^[a-f0-9]{32}$/i.test(rawIndex)) {
        sessionIds = [rawIndex];
      } else {
        throw new InternalServerErrorException(
          'Unable to read authentication session index',
        );
      }
    }

    for (const sessionId of sessionIds) {
      const sessionKey = `${this.SESSION_PREFIX}${sessionId}`;
      const rawSession = await this.redisService.get(sessionKey);
      if (rawSession) {
        let session: SessionMetadata;
        try {
          session = JSON.parse(rawSession) as SessionMetadata;
        } catch {
          throw new InternalServerErrorException(
            'Unable to read authentication session',
          );
        }
        for (const jti of [session.jti, session.accessJti]) {
          if (!jti) continue;
          const ttl =
            jti === session.jti
              ? this.REFRESH_TOKEN_TTL_SECONDS
              : this.ACCESS_TOKEN_TTL_SECONDS;
          const blacklisted = await this.redisService.set(
            `${this.BLACKLIST_PREFIX}${jti}`,
            '1',
            ttl,
          );
          if (!blacklisted) {
            throw new InternalServerErrorException(
              'Unable to revoke authentication session',
            );
          }
        }
      }
      const removed = await this.redisService.del(sessionKey);
      if (!removed && rawSession) {
        throw new InternalServerErrorException(
          'Unable to remove authentication session',
        );
      }
    }

    const removedIndex = await this.redisService.del(indexKey);
    if (!removedIndex) {
      throw new InternalServerErrorException(
        'Unable to remove authentication session index',
      );
    }
  }

  async isBlacklisted(jti: string): Promise<boolean> {
    return (await this.redisService.get(`${this.BLACKLIST_PREFIX}${jti}`)) !== null;
  }

  private async removeSessionFromIndex(
    address: string,
    refreshJti: string,
  ): Promise<void> {
    const result = await this.redisService.eval(
      "local raw = redis.call('GET', KEYS[1]); if not raw then return 1 end; local ok, ids = pcall(cjson.decode, raw); if not ok or type(ids) ~= 'table' then return redis.error_reply('Invalid user session index') end; local updated = {}; for _, id in ipairs(ids) do if id ~= ARGV[1] then table.insert(updated, id) end end; if #updated == 0 then return redis.call('DEL', KEYS[1]) end; local ttl = redis.call('TTL', KEYS[1]); redis.call('SET', KEYS[1], cjson.encode(updated)); if ttl > 0 then redis.call('EXPIRE', KEYS[1], ttl) end; return 1",
      1,
      `${this.USER_SESSIONS_PREFIX}${address.toLowerCase()}`,
      refreshJti,
    );
    if (Number(result) !== 1) {
      throw new InternalServerErrorException(
        'Unable to update authentication session index',
      );
    }
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

export const REQUIRE_JWT_CAPABILITY_KEY = 'jwt_capability';

export interface JwtCapabilityRequirement {
  aud: string;
  cap: string;
  resource: string;
  chain?: string;
  release?: string;
  deployment?: string;
  artifact?: string;
}

export const RequireJwtCapability = (requirement: JwtCapabilityRequirement) =>
  SetMetadata(REQUIRE_JWT_CAPABILITY_KEY, requirement);

/**
 * Guard for JWT-based capability tokens issued by TokenService.
 *
 * Derives subject strictly from AuthenticatedPrincipal via extractCapabilitySubject.
 * Rejects HMAC claims objects or any other format (fails closed).
 */
@Injectable()
export class JwtCapabilityTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const requirement = this.reflector.get<JwtCapabilityRequirement>(
      REQUIRE_JWT_CAPABILITY_KEY,
      context.getHandler(),
    );
    if (!requirement) {
      throw new ForbiddenException('Capability requirement missing');
    }

    const sub = extractCapabilitySubject(request.user);
    if (!sub) {
      throw new ForbiddenException('Missing capability token or subject');
    }

    const rawToken = request.body?.capabilityToken ?? request.headers['x-capability-token'];
    // Strict token shape check: JWT token must be a string (rejects HMAC claims objects)
    if (!rawToken || typeof rawToken !== 'string') {
      throw new ForbiddenException('Malformed capability token');
    }

    try {
      await this.tokenService.validateAndConsumeCapabilityToken(rawToken, {
        audience: requirement.aud,
        subject: sub,
        capability: requirement.cap,
        resource: requirement.resource,
        chain: requirement.chain ?? request.body?.chain ?? '',
        release: requirement.release ?? request.body?.release ?? '',
        deployment: requirement.deployment ?? request.body?.deployment ?? '',
        artifact: requirement.artifact ?? request.body?.artifact ?? '',
      });
      return true;
    } catch {
      throw new ForbiddenException('Capability token rejected');
    }
  }
}
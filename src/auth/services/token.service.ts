import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { randomBytes, createHash } from 'crypto';

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
 * Token Service
 *
 * Responsible for:
 * - JWT access token generation & validation
 * - Refresh token generation, rotation, and invalidation
 * - Token blacklisting (for logout/revoke)
 * - Token TTL management
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  private readonly ACCESS_TOKEN_TTL_SECONDS: number;
  private readonly REFRESH_TOKEN_TTL_SECONDS: number;
  private readonly REFRESH_TOKEN_BYTES = 48; // 384-bit random value
  private readonly BLACKLIST_PREFIX = 'auth:blacklist:';

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    // Parse access token TTL from JWT_EXPIRATION env (default: 15 min)
    const accessTtlRaw =
      configService.get<string>('JWT_EXPIRATION', '15m');
    this.ACCESS_TOKEN_TTL_SECONDS = this.parseTtlToSeconds(accessTtlRaw);

    // Refresh token TTL (default: 7 days)
    const refreshTtlRaw =
      configService.get<string>('REFRESH_TOKEN_EXPIRATION', '7d');
    this.REFRESH_TOKEN_TTL_SECONDS = this.parseTtlToSeconds(refreshTtlRaw);
  }

  /**
   * Generate an access + refresh token pair.
   */
  async generateTokenPair(
    address: string,
    userId: string | null,
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

    // Store refresh token metadata in Redis
    const refreshKey = `auth:refresh:${refreshJti}`;
    const refreshData = {
      jti: refreshJti,
      tokenHash: this.hashToken(refreshToken),
      address: address.toLowerCase(),
      userId,
      accessJti,
      createdAt: Date.now(),
    };

    await this.redisService.set(
      refreshKey,
      JSON.stringify(refreshData),
      this.REFRESH_TOKEN_TTL_SECONDS,
    );

    // Also store mapping from address to active refresh tokens (for revocation)
    const userRefreshKey = `auth:user_refresh:${address.toLowerCase()}`;
    const existingRefreshes = await this.redisService.get(userRefreshKey);
    const refreshList: string[] = existingRefreshes
      ? JSON.parse(existingRefreshes)
      : [];
    refreshList.push(refreshJti);

    // Clean up old entries if list is too long
    if (refreshList.length > 10) {
      const toRemove = refreshList.slice(0, refreshList.length - 10);
      for (const oldJti of toRemove) {
        await this.redisService.del(`auth:refresh:${oldJti}`);
      }
      refreshList.splice(0, refreshList.length - 10);
    }

    await this.redisService.set(
      userRefreshKey,
      JSON.stringify(refreshList),
      this.REFRESH_TOKEN_TTL_SECONDS,
    );

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
  ): Promise<TokenPair> {
    const parts = refreshTokenRaw.split('.');
    if (parts.length !== 2) {
      throw new UnauthorizedException('Malformed refresh token');
    }

    const [refreshJti, tokenValue] = parts;
    const refreshKey = `auth:refresh:${refreshJti}`;

    // Check blacklist
    const isBlacklisted = await this.redisService.get(
      `${this.BLACKLIST_PREFIX}${refreshJti}`,
    );
    if (isBlacklisted) {
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    // Retrieve stored refresh data
    const raw = await this.redisService.get(refreshKey);
    if (!raw) {
      throw new UnauthorizedException('Refresh token not found or expired');
    }

    let storedData: any;
    try {
      storedData = JSON.parse(raw);
    } catch {
      throw new UnauthorizedException('Invalid refresh token data');
    }

    // Verify token hash
    const tokenHash = this.hashToken(tokenValue);
    if (tokenHash !== storedData.tokenHash) {
      // Potential token theft — revoke all user's refresh tokens
      await this.revokeAllUserTokens(storedData.address);
      throw new UnauthorizedException('Refresh token mismatch — all sessions revoked');
    }

    // Invalidate the old refresh token (rotation)
    await this.redisService.del(refreshKey);
    await this.blacklistToken(refreshJti, this.REFRESH_TOKEN_TTL_SECONDS);

    // Issue new token pair
    const newPair = await this.generateTokenPair(
      storedData.address,
      storedData.userId,
    );

    return newPair;
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
  async revokeAllUserTokens(address: string): Promise<void> {
    const userRefreshKey = `auth:user_refresh:${address.toLowerCase()}`;
    const raw = await this.redisService.get(userRefreshKey);

    if (raw) {
      try {
        const refreshList: string[] = JSON.parse(raw);
        for (const jti of refreshList) {
          await this.redisService.del(`auth:refresh:${jti}`);
          await this.blacklistToken(jti, this.REFRESH_TOKEN_TTL_SECONDS);
        }
      } catch {
        // If parse fails, just clean up the key
      }
    }

    await this.redisService.del(userRefreshKey);
  }

  /**
   * Logout: blacklist the current access token JTI and revoke associated refresh tokens.
   */
  async logout(payload: TokenPayload): Promise<void> {
    if (payload.jti) {
      // Blacklist the access token for its remaining TTL
      const remainingTtl = payload.exp
        ? Math.max(0, payload.exp - Math.floor(Date.now() / 1000))
        : this.ACCESS_TOKEN_TTL_SECONDS;
      await this.blacklistToken(payload.jti, remainingTtl);
    }

    // Revoke all refresh tokens for the user
    await this.revokeAllUserTokens(payload.address);
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

  // ── Private helpers ──────────────────────────────────────────────────────

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
    const match = ttl.match(/^(\d+)(s|m|h|d)$/);
    if (!match) {
      return 900; // Default 15 minutes
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 3600;
      case 'd':
        return value * 86400;
      default:
        return 900;
    }
  }
}

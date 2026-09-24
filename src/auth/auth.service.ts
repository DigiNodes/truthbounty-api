import { Injectable, BadRequestException, UnauthorizedException, InternalServerErrorException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { verifyMessage } from 'ethers';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RedisService } from '../redis/redis.service';
import { SiweService } from './services/siwe.service';
import { TokenService, TokenPair } from './services/token.service';

interface ChallengeRecord {
  nonce: string;
  issuedAt: number; // Unix ms — app-layer TTL source of truth
}

@Injectable()
export class AuthService {
  private readonly NONCE_TTL_SECONDS = 5 * 60; // 5 minutes — kept in sync with Redis SETEX

  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private redisService: RedisService,
    private siweService: SiweService,
    private tokenService: TokenService,
    private configService: ConfigService,
  ) {}

  /**
   * Generate a nonce challenge for a wallet address.
   * Supports both SIWE (EIP-4361) and legacy format.
   */
  async generateChallenge(
    address: string,
    options?: { chainId?: number; domain?: string; uri?: string },
  ): Promise<{ message: string; format: 'siwe' | 'legacy' }> {
    const nonce = this.generateRandomNonce();
    const key = `auth:nonce:${address.toLowerCase()}`;
    const record: ChallengeRecord = { nonce, issuedAt: Date.now() };

    try {
      const ok = await this.redisService.set(key, JSON.stringify(record), this.NONCE_TTL_SECONDS);
      if (!ok) {
        this.logger.error(`Failed to persist nonce for ${address}`);
        throw new InternalServerErrorException('Failed to generate challenge. Please try again later.');
      }
    } catch (err) {
      this.logger.error(`Error persisting nonce for ${address}: ${err?.message ?? err}`);
      throw new InternalServerErrorException('Failed to generate challenge. Please try again later.');
    }

    // If SIWE parameters are provided, build a SIWE-compliant message
    if (options?.domain || options?.uri || options?.chainId) {
      const domain = options.domain || this.configService.get<string>('SIWE_DOMAIN', 'truthbounty.com');
      const uri = options.uri || this.configService.get<string>('SIWE_ORIGIN', 'https://app.truthbounty.com');
      const chainId = options.chainId || 1;

      const message = this.siweService.buildSiweMessage({
        domain,
        address,
        uri,
        chainId,
        nonce,
        statement: 'Sign in to TruthBounty — decentralized news verification',
      });
      return { message, format: 'siwe' };
    }

    // Legacy format for backward compatibility
    return {
      message: this.siweService.buildLegacyMessage(nonce),
      format: 'legacy',
    };
  }

  /**
   * Verify wallet signature and issue JWT access + refresh tokens.
   * Supports both SIWE (EIP-4361) and legacy message formats.
   */
  async login(loginDto: LoginDto): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; user: any }> {
    const { address, signature, message } = loginDto;

    // 1. Verify the signature
    let recoveredAddress: string;
    try {
      recoveredAddress = verifyMessage(message, signature);
    } catch (error) {
      throw new BadRequestException('Invalid signature format');
    }

    // 2. Check if recovered address matches the claimed address
    if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
      throw new UnauthorizedException('Signature verification failed. Address mismatch.');
    }

    // 3. Verify the message contains a valid, non-expired nonce
    const key = `auth:nonce:${address.toLowerCase()}`;
    const raw = await this.redisService.get(key);
    if (!raw) {
      throw new UnauthorizedException('No challenge found or challenge expired. Please request a challenge first.');
    }

    let record: ChallengeRecord;
    try {
      record = JSON.parse(raw) as ChallengeRecord;
    } catch {
      // Stored value is not a valid record — treat as expired/invalid
      await this.redisService.del(key).catch(() => null);
      throw new UnauthorizedException('No challenge found or challenge expired. Please request a challenge first.');
    }

    // App-layer TTL check: enforce expiry independently of Redis to prevent
    // Redis-vs-app clock desync (BE-182). Redis TTL is the backstop;
    // this check is the authoritative gate.
    const elapsedSeconds = (Date.now() - record.issuedAt) / 1000;
    if (elapsedSeconds >= this.NONCE_TTL_SECONDS) {
      await this.redisService.del(key).catch(() => null);
      throw new UnauthorizedException('Challenge expired. Please request a new challenge.');
    }

    const expectedMessage = `Sign in to TruthBounty: ${record.nonce}`;

    // Compare the full challenge message in constant time to avoid timing attacks.
    if (!this.constantTimeEquals(message, expectedMessage)) {
      throw new UnauthorizedException('Invalid nonce in message.');
    }

    // Delete used nonce (prevent replay attacks)
    await this.redisService.del(key).catch(() => null);

    // 7. Find or create user
    let user = await this.prisma.wallet.findFirst({
      where: { address: address.toLowerCase() },
      include: { user: true },
    });

    // If wallet doesn't exist, we can still allow login but user won't have full access
    // until they link their wallet properly
    const userId = user?.user?.id || null;

    // 8. Generate token pair (access + refresh)
    const tokenPair = await this.tokenService.generateTokenPair(
      address.toLowerCase(),
      userId,
    );

    return {
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      expiresIn: tokenPair.expiresIn,
      user: {
        id: userId,
        address: address.toLowerCase(),
      },
    };
  }

  /**
   * Refresh an access token using a refresh token.
   */
  async refresh(refreshToken: string): Promise<TokenPair & { user: any }> {
    const pair = await this.tokenService.refreshAccessToken(refreshToken);

    // Resolve user info for the response
    const payload = this.jwtService.decode(pair.accessToken) as any;
    const wallet = await this.prisma.wallet.findFirst({
      where: { address: payload?.address },
      include: { user: true },
    });

    return {
      ...pair,
      user: {
        id: wallet?.user?.id || payload?.userId || null,
        address: payload?.address,
      },
    };
  }

  /**
   * Logout: invalidate the current session tokens.
   */
  async logout(payload: any): Promise<void> {
    if (!payload || !payload.address) {
      throw new BadRequestException('Invalid token payload');
    }
    await this.tokenService.logout(payload);
  }

  /**
   * Revoke all sessions for a wallet address (admin action).
   */
  async revoke(address: string): Promise<void> {
    await this.tokenService.revokeAllUserTokens(address);
  }

  /**
   * Validate JWT token and return user info
   */
  async validateToken(payload: any): Promise<any> {
    let { address, userId } = payload;

    // If sub contains an address (0x...), prefer it for the wallet lookup
    const sub = payload.sub;
    const candidateAddress =
      address || (typeof sub === 'string' && sub.startsWith('0x') ? sub : undefined);

    // Verify wallet still exists using the best available address
    const wallet = candidateAddress
      ? await this.prisma.wallet.findFirst({
          where: { address: candidateAddress },
          include: { user: true },
        })
      : null;

    // Validate token is not blacklisted
    if (payload.jti) {
      const isBlacklisted = await this.tokenService.isBlacklisted(payload.jti);
      if (isBlacklisted) {
        this.logger.warn(`Blacklisted token used: ${payload.jti}`);
        return null;
      }
    }

    return {
      address: wallet?.address || address,
      userId: wallet?.user?.id || userId,
      user: wallet?.user || null,
      jti: payload.jti,
      sub: payload.sub,
    };
  }

  /**
   * Generate a random nonce
   */
  private generateRandomNonce(): string {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const length = 32;
    let nonce = '';

    // Use crypto for secure random generation
    const crypto = require('crypto');
    const bytes = crypto.randomBytes(length);

    for (let i = 0; i < length; i++) {
      nonce += characters[bytes[i] % characters.length];
    }

    return nonce;
  }

  /**
   * Constant-time string comparison for challenge messages.
   */
  private constantTimeEquals(a: string, b: string): boolean {
    const aBuffer = Buffer.from(a, 'utf8');
    const bBuffer = Buffer.from(b, 'utf8');

    if (aBuffer.length !== bBuffer.length) {
      return false;
    }

    return timingSafeEqual(aBuffer, bBuffer);
  }
}

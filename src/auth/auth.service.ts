import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { verifyMessage } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RedisService } from '../redis/redis.service';
import { SiweService } from './services/siwe.service';
import { TokenService, TokenPair } from './services/token.service';
import {
  AUTH_GENERIC_FAILURE_MESSAGE,
  constantTimeAddressEqual,
  timingSafeEqualUtf8,
} from '../common/utils/timing-safe.util';
import {
  AuthenticatedPrincipal,
} from './types/authenticated-request';

interface ChallengeRecord {
  nonce: string;
  issuedAt: number; // Unix ms — app-layer TTL source of truth
}

interface LoginResponseUser {
  id: string | null;
  address: string;
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: LoginResponseUser;
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
      const ok = await this.redisService.set(
        key,
        JSON.stringify(record),
        this.NONCE_TTL_SECONDS,
      );
      if (!ok) {
        this.logger.error('Failed to persist wallet challenge');
        throw new InternalServerErrorException(
          'Failed to generate challenge. Please try again later.',
        );
      }
    } catch (err) {
      this.logger.error('Error persisting wallet challenge');
      throw new InternalServerErrorException(
        'Failed to generate challenge. Please try again later.',
      );
    }

    // If SIWE parameters are provided, build a SIWE-compliant message
    if (options?.domain || options?.uri || options?.chainId) {
      const allowedDomains = this.getAllowedSiweDomains();
      const allowedOrigins = this.getAllowedSiweOrigins();
      const domain =
        options.domain ??
        this.configService.get<string>('SIWE_DOMAIN', 'truthbounty.com');
      const uri =
        options.uri ??
        this.configService.get<string>(
          'SIWE_ORIGIN',
          allowedOrigins[0] ?? 'https://app.truthbounty.com',
        );
      const supportedChainIds = this.getSupportedSiweChainIds();
      const chainId = options.chainId ?? supportedChainIds[0] ?? 1;
      let uriOrigin: string;
      try {
        uriOrigin = new URL(uri).origin;
      } catch {
        throw new BadRequestException('Unsupported SIWE challenge parameters');
      }
      if (
        (allowedDomains.length > 0 &&
          !allowedDomains.some(
            (allowed) => allowed.toLowerCase() === domain.toLowerCase(),
          )) ||
        (allowedOrigins.length > 0 && !allowedOrigins.includes(uriOrigin)) ||
        (supportedChainIds.length > 0 &&
          !supportedChainIds.includes(chainId))
      ) {
        throw new BadRequestException('Unsupported SIWE challenge parameters');
      }

      const message = this.siweService.buildSiweMessage({
        domain,
        address,
        uri,
        chainId,
        nonce,
        statement: this.configService.get<string>(
          'SIWE_EXPECTED_STATEMENT',
          'Sign in to TruthBounty — decentralized news verification',
        ),
      });
      return { message, format: 'siwe' };
    }

    // Legacy format for backward compatibility
    return {
      message: this.siweService.buildLegacyMessage(nonce),
      format: 'legacy',
    };
  }

  private getSupportedSiweChainIds(): number[] {
    const configured = this.configService.get<string>(
      'SIWE_SUPPORTED_CHAIN_IDS',
      '10',
    );
    return configured
      .split(',')
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0);
  }

  private getAllowedSiweDomains(): string[] {
    const configured = this.configService.get<string>(
      'SIWE_ALLOWED_DOMAINS',
      '',
    );
    if (configured.trim()) {
      return configured
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    }
    return [
      this.configService.get<string>('SIWE_DOMAIN', 'truthbounty.com'),
    ];
  }

  private getAllowedSiweOrigins(): string[] {
    const configured = this.configService.get<string>(
      'SIWE_ALLOWED_ORIGINS',
      '',
    );
    if (configured.trim()) {
      return configured
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    }
    const expectedOrigin = this.configService.get<string>(
      'SIWE_ORIGIN',
      'https://app.truthbounty.com',
    );
    try {
      return [new URL(expectedOrigin).origin];
    } catch {
      return [];
    }
  }

  /**
   * Verify wallet signature and issue JWT access + refresh tokens.
   * Supports both SIWE (EIP-4361) and legacy message formats.
   */
  async login(loginDto: LoginDto): Promise<LoginResponse> {
    const { address, signature, message } = loginDto;
    const normalizedAddress = address.toLowerCase();
    const key = `auth:nonce:${normalizedAddress}`;

    // SIWE-looking messages must pass strict SIWE verification; they never
    // fall back to the legacy message contract.
    const isSiweMessage = message.includes(
      'wants you to sign in with your Ethereum account',
    );
    let recoveredAddress: string;
    if (isSiweMessage) {
      try {
        const result = await this.siweService.verifySiwe({
          message,
          signature,
          allowedDomains: this.getAllowedSiweDomains(),
          allowedOrigins: this.getAllowedSiweOrigins(),
          supportedChainIds: this.getSupportedSiweChainIds(),
          expectedStatement: this.configService.get<string>(
            'SIWE_EXPECTED_STATEMENT',
            'Sign in to TruthBounty — decentralized news verification',
          ),
        });
        if (!result.success || !result.data?.address || !result.address) {
          this.logger.warn('Login failed [siwe-verification]');
          timingSafeEqualUtf8(message, message);
          throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
        }
        recoveredAddress = result.address;
      } catch {
        this.logger.warn('Login failed [siwe-verification]');
        timingSafeEqualUtf8(message, message);
        throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
      }
    } else {
      try {
        recoveredAddress = verifyMessage(message, signature);
      } catch {
        this.logger.warn('Login failed [signature-parse]');
        timingSafeEqualUtf8(message, message);
        throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
      }
    }

    // 2. Check if recovered address matches the claimed address (timing-safe).
    if (!constantTimeAddressEqual(recoveredAddress, address)) {
      this.logger.warn('Login failed [address-mismatch]');
      timingSafeEqualUtf8(message, message);
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }
    const verifiedAddress = recoveredAddress.toLowerCase();

    // 3. Verify the message contains a valid, non-expired nonce.
    // Fetch the challenge record regardless of the address-match outcome shape
    // above so hit-vs-miss timing is bounded by the same Redis + compare work.
    const raw = await this.redisService.get(key);
    if (!raw) {
      this.logger.warn('Login failed [challenge-not-found]');
      timingSafeEqualUtf8(message, message);
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    let record: ChallengeRecord;
    try {
      record = JSON.parse(raw) as ChallengeRecord;
    } catch {
      // Stored value is not a valid record — treat as expired/invalid
      await this.redisService.del(key).catch(() => null);
      this.logger.warn('Login failed [challenge-corrupt]');
      timingSafeEqualUtf8(message, message);
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    // App-layer TTA check: enforce expiry independently of Redis to prevent
    // Redis-vs-app clock desync (BE-182). Redis TTL is the backstop;
    // this check is the authoritative gate.
    const elapsedSeconds = (Date.now() - record.issuedAt) / 1000;
    if (elapsedSeconds >= this.NONCE_TTL_SECONDS) {
      await this.redisService.del(key).catch(() => null);
      this.logger.warn('Login failed [challenge-expired]');
      timingSafeEqualUtf8(message, message);
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    if (isSiweMessage) {
      const parsed = this.siweService.parseMessage(message);
      if (
        !parsed ||
        parsed.nonce !== record.nonce ||
        !constantTimeAddressEqual(parsed.address, recoveredAddress)
      ) {
        this.logger.warn('Login failed [nonce-mismatch]');
        timingSafeEqualUtf8(message, message);
        throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
      }
    } else {
      const expectedMessage = `Sign in to TruthBounty: ${record.nonce}`;
      if (!timingSafeEqualUtf8(message, expectedMessage)) {
        this.logger.warn('Login failed [nonce-mismatch]');
        throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
      }
    }

    // Compare-and-delete the exact challenge record atomically so concurrent
    // logins cannot both consume the same nonce. Redis errors fail closed.
    let consumed: unknown;
    try {
      consumed = await this.redisService.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        1,
        key,
        raw,
      );
    } catch {
      this.logger.warn('Login failed [challenge-consumption]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }
    if (Number(consumed) !== 1) {
      this.logger.warn('Login failed [challenge-replayed]');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    // 7. Find or create user
    const user = await this.prisma.wallet.findFirst({
      where: { address: verifiedAddress },
      include: { user: true },
    });

    // If wallet doesn't exist, we can still allow login but user won't have full access
    // until they link their wallet properly
    const userId = user?.user?.id || null;

    // 8. Generate token pair (access + refresh)
    const tokenPair = await this.tokenService.generateTokenPair(
      verifiedAddress,
      userId,
    );

    return {
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      expiresIn: tokenPair.expiresIn,
      user: {
        id: userId,
        address: verifiedAddress,
      },
    };
  }

  /**
   * Refresh an access token using a refresh token.
   */
  async refresh(refreshToken: string): Promise<TokenPair & { user: LoginResponseUser }> {
    const pair = await this.tokenService.refreshAccessToken(refreshToken);

    // Resolve user info for the response
    const decoded = this.jwtService.decode(pair.accessToken);
    const payload =
      decoded && typeof decoded === 'object'
        ? (decoded as { address?: string; userId?: string })
        : {};
    const wallet = payload.address
      ? await this.prisma.wallet.findFirst({
          where: { address: payload.address },
          include: { user: true },
        })
      : null;

    return {
      ...pair,
      user: {
        id: wallet?.user?.id || payload.userId || null,
        address: payload.address || '',
      },
    };
  }

  /**
   * Logout: invalidate the current session tokens.
   */
  async logout(payload: AuthenticatedPrincipal): Promise<void> {
    if (!payload || !payload.address) {
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
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
   * Validate JWT token and return the canonical authenticated principal.
   * Returns null when the token is blacklisted or the principal cannot be
   * resolved -- the caller (strategy) fails closed.
   */
  async validateToken(payload: JwtPayloadInput): Promise<AuthenticatedPrincipal | null> {
    const expectedAudience = this.configService.get<string>(
      'JWT_ACCESS_AUDIENCE',
      'truthbounty-api',
    );
    const expectedIssuer = this.configService.get<string>(
      'JWT_ISSUER',
      'truthbounty-api',
    );
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
      !audiences.includes(expectedAudience) ||
      payload.iss !== expectedIssuer
    ) {
      return null;
    }

    const { address, userId } = payload;
    const expectedSubject = userId ? String(userId) : address.toLowerCase();
    if (payload.sub !== expectedSubject) return null;

    const candidateAddress = address.toLowerCase();

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

    const resolvedAddress = wallet?.address || candidateAddress;
    if (!resolvedAddress) {
      // Fail closed: no principal address can be resolved.
      return null;
    }

    return {
      address: resolvedAddress,
      userId: wallet?.user?.id || userId || null,
      user: wallet?.user
        ? {
            id: wallet.user.id,
            role: wallet.user.role,
          }
        : null,
      jti: payload.jti,
      sub: payload.sub,
    };
  }

  /**
   * Generate a random nonce
   */
  private generateRandomNonce(): string {
    const characters =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
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
   * Delegates to the shared timing-safe helper (dummy compare on length
   * mismatch so length is not leaked via early return).
   */
  private constantTimeEquals(a: string, b: string): boolean {
    return timingSafeEqualUtf8(a, b);
  }
}

/**
 * Minimal shape of the verified JWT payload this service accepts.
 * Kept explicit to avoid `any` at the validation boundary.
 */
export interface JwtPayloadInput {
  address?: string;
  userId?: string | null;
  sub?: string;
  jti?: string;
  type?: string;
  aud?: string | string[];
  iss?: string;
}

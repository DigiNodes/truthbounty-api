import {
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
  AUTG_GENERIC_FAILURE_MESSAGE,
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
        this.logger.error(`Failed to persist nonce for ${address}`);
        throw new InternalServerErrorException(
          'Failed to generate challenge. Please try again later.',
        );
      }
    } catch (err) {
      this.logger.error(
        `Error persisting nonce for ${address}: ${err?.message ?? err}`,
      );
      throw new InternalServerErrorException(
        'Failed to generate challenge. Please try again later.',
      );
    }

    // If SIWE parameters are provided, build a SIWE-compliant message
    if (options?.domain || options?.uri || options?.chainId) {
      const domain =
        options.domain ||
        this.configService.get<string>('SIWE_DOMAIN', 'truthbounty.com');
      const uri =
        options.uri ||
        this.configService.get<string>(
          'SIWE_ORIGIN',
          'https://app.truthbounty.com',
        );
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
   *
   * The challenge is consumed with a single atomic Redis compare-and-delete
   * BEFORE any token is issued. Only the request that successfully deletes the
   * stored challenge may proceed; concurrent or replayed requests see the
   * challenge as missing and receive the generic failure response. Redis
   * errors during consumption fail closed.
   */
  async login(loginDto: LoginDto): Promise<LoginResponse> {
    const { address, signature, message } = loginDto;
    const normalizedAddress = address.toLowerCase();
    const key = `auth:nonce:${normalizedAddress}`;

    // 1. Verify the signature — all failures collapse to a constant-shape
    // 401 so callers cannot distinguish bad signature / address mismatch /
    // missing challenge / expired challenge / invalid nonce via status,
    // message, code, or timing. Distinct reasons are logged server-side only.
    let recoveredAddress: string;
    try {
      recoveredAddress = verifyMessage(message, signature);
    } catch (error) {
      this.logger.warn(
        `Login failed [signature-parse] for ${normalizedAddress}`,
      );
      // Dummy timing-safe work to normalize the failure path.
      timingSafeEqualUtf8(message, message);
      throw new UnauthorizedException(AUTG_GENERIC_FAILURE_MESSAGE);
    }

    // 2. Check if recovered address matches the claimed address (timing-safe).
    if (!constantTimeAddressEqual(recoveredAddress, address)) {
      this.logger.warn(
        `Login failed [address-mismatch] for ${normalizedAddress}`,
      );
      timingSafeEqualUtf8(message, message);
      throw new UnauthorizedException(AUTG_GENERIC_FAILURE_MESSAGE);
    }

    // 3. Read the challenge record. It is NOT deleted yet: we only consume it
    // once the message has been fully validated, and the consume itself is an
    // atomic compare-and-delete against the exact stored value.
    const raw = await this.redisService.get(key);
    if (!raw) {
      this.logger.warn(
        `Login failed [challenge-not-found] for ${normalizedAddress}`,
      );
      timingSafeEqualUtf8(message, message);
      throw new UnauthorizedException(AUTG_GENERIC_FAILURE_MESSAGE);
    }

    let record: ChallengeRecord;
    try {
      record = JSON.parse(raw) as ChallengeRecord;
    } catch {
      // Stored value is not a valid record — treat as invalid and consume it so
      // it can never be used again.
      await this.consumeChallengeOrFail(key, raw, normalizedAddress, 'challenge-corrupt');
      timingSafeEqualUtf8(message, message);
      throw new UnauthorizedException(AUTG_GENERIC_FAILURE_MESSAGE);
    }

    // App-layer TTL check: enforce expiry independently of Redis to prevent
    // Redis-vs-app clock desync (BE-182). Redis TTL is the backstop;
    // this check is the authoritative gate.
    const elapsedSeconds = (Date.now() - record.issuedAt) / 1000;
    if (elapsedSeconds >= this.NONCE_TTL_SECONDS) {
      await this.consumeChallengeOrFail(key, raw, normalizedAddress, 'challenge-expired');
      timingSafeEqualUtf8(message, message);
      throw new UnauthorizedException(AUTG_GENERIC_FAILURE_MESSAGE);
    }

    const expectedMessage = `Sign in to TruthBounty: ${record.nonce}`;

    // Compare the full challenge message in constant time to avoid timing attacks.
    // A mismatched message must NOT consume the active challenge.
    if (!timingSafeEqualUtf8(message, expectedMessage)) {
      this.logger.warn(
        `Login failed [nonce-mismatch] for ${normalizedAddress}`,
      );
      throw new UnauthorizedException(AUTG_GENERIC_FAILURE_MESSAGE);
    }

    // 4. Atomically consume the challenge. Only one concurrent request can
    // observe 'consumed'; every other outcome fails closed.
    await this.consumeChallengeOrFail(key, raw, normalizedAddress, 'challenge-consume-race');

    // 5. Find or create user
    const user = await this.prisma.wallet.findFirst({
      where: { address: normalizedAddress },
      include: { user: true },
    });

    // If wallet doesn't exist, we can still allow login but user won't have full access
    // until they link their wallet properly
    const userId = user?.user?.id || null;

    // 6. Generate token pair (access + refresh) — only after successful consume.
    const tokenPair = await this.tokenService.generateTokenPair(
      normalizedAddress,
      userId,
    );

    return {
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      expiresIn: tokenPair.expiresIn,
      user: {
        id: userId,
        address: normalizedAddress,
      },
    };
  }

  /**
   * Atomically consume a challenge record. Throws the generic 401 unless the
   * exact stored value was present and deleted by this call. Redis errors and
   * ambiguous outcomes are treated as failure (fail closed).
   */
  private async consumeChallengeOrFail(
    key: string,
    expectedRaw: string,
    normalizedAddress: string,
    reason: string,
  ): Promise<void> {
    let outcome: 'consumed' | 'mismatch' | 'missing';
    try {
      outcome = await this.redisService.compareAndDelete(key, expectedRaw);
    } catch (error) {
      this.logger.error(
        `Login failed [consume-unavailable:${reason}] for ${normalizedAddress}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      timingSafeEqualUtf8(expectedRaw, expectedRaw);
      throw new UnauthorizedException(AUTG_GENERIC_FAILURE_MESSAGE);
    }

    if (outcome !== 'consumed') {
      this.logger.warn(
        `Login failed [${outcome === 'missing' ? 'challenge-consumed' : 'challenge-changed'}:${reason}] for ${normalizedAddress}`,
      );
      timingSafeEqualUtf8(expectedRaw, expectedRaw);
      throw new UnauthorizedException(AUTG_GENERIC_FAILURE_MESSAGE);
    }
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
      throw new UnauthorizedException(AUTG_GENERIC_FAILURE_MESSAGE);
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
    const { address, userId } = payload;

    // If sub contains an address (0x...), prefer it for the wallet lookup
    const sub = payload.sub;
    const candidateAddress =
      address ||
      (typeof sub === 'string' && sub.startsWith('0x') ? sub : undefined);

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
  userId?: string;
  sub?: string;
  jti?: string;
}

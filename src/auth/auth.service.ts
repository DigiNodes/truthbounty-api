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
  AUTH_GENERIC_FAILURE_MESSAGE,
  constantTimeAddressEqual,
  timingSafeEqualUtf8,
} from '../common/utils/timing-safe.util';
import { AuthenticatedPrincipal } from './types/authenticated-request';
import {
  ParsedSiweMessage,
  SiweVerifyResult,
} from './types/siwe.types';

const SIWE_ENVELOPE = 'wants you to sign in with your Ethereum account';
const DEFAULT_SIWE_STATEMENT =
  'Sign in to TruthBounty — decentralized news verification';

interface ChallengeRecord {
  nonce: string;
  issuedAt: number; // Unix ms — app-layer TTL source of truth
  address?: string;
  siwe?: {
    domain: string;
    uri: string;
    chainId: number;
    statement: string;
  };
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
    const normalizedAddress = address.toLowerCase();
    const key = `auth:nonce:${normalizedAddress}`;

    const siwe =
      options?.domain || options?.uri || options?.chainId
        ? {
            domain:
              options.domain ||
              this.configService.get<string>('SIWE_DOMAIN', 'truthbounty.com'),
            uri:
              options.uri ||
              this.configService.get<string>(
                'SIWE_ORIGIN',
                'https://app.truthbounty.com',
              ),
            chainId: options.chainId || 1,
            statement: DEFAULT_SIWE_STATEMENT,
          }
        : undefined;

    const message = siwe
      ? this.siweService.buildSiweMessage({
          ...siwe,
          address,
          nonce,
        })
      : this.siweService.buildLegacyMessage(nonce);

    const record: ChallengeRecord = {
      nonce,
      issuedAt: Date.now(),
      address: normalizedAddress,
      ...(siwe ? { siwe } : {}),
    };

    try {
      const ok = await this.redisService.set(
        key,
        JSON.stringify(record),
        this.NONCE_TTL_SECONDS,
      );
      if (!ok) {
        this.logger.error('Failed to persist nonce challenge');
        throw new InternalServerErrorException(
          'Failed to generate challenge. Please try again later.',
        );
      }
    } catch (err) {
      this.logger.error(
        `Error persisting nonce challenge: ${err?.message ?? err}`,
      );
      throw new InternalServerErrorException(
        'Failed to generate challenge. Please try again later.',
      );
    }

    return { message, format: siwe ? 'siwe' : 'legacy' };
  }

  /**
   * Verify wallet signature and issue JWT access + refresh tokens.
   * Supports both SIWE (EIP-4361) and legacy message formats.
   */
  async login(loginDto: LoginDto): Promise<LoginResponse> {
    const { address, signature, message } = loginDto;
    const normalizedAddress = typeof address === 'string' ? address.toLowerCase() : '';
    const key = `auth:nonce:${normalizedAddress}`;

    const fail = (reason: string): never => {
      this.logger.warn(`Login failed [${reason}] for ${normalizedAddress}`);
      timingSafeEqualUtf8(message ?? '', message ?? '');
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    };

    const isSiwe = this.isSiweMessage(message);
    let legacySigner: string | undefined;
    if (!isSiwe) {
      try {
        legacySigner = verifyMessage(message, signature);
      } catch {
        return fail('signature-parse');
      }
      if (!constantTimeAddressEqual(legacySigner, normalizedAddress)) {
        return fail('address-mismatch');
      }
    }

    let raw: string | null;
    try {
      raw = await this.redisService.get(key);
    } catch {
      return fail('challenge-read-error');
    }
    if (!raw) {
      return fail('challenge-not-found');
    }

    let record: ChallengeRecord;
    try {
      record = JSON.parse(raw) as ChallengeRecord;
    } catch {
      await this.redisService.del(key).catch(() => null);
      return fail('challenge-corrupt');
    }
    if (
      !record ||
      typeof record.nonce !== 'string' ||
      !Number.isFinite(record.issuedAt)
    ) {
      await this.redisService.del(key).catch(() => null);
      return fail('challenge-corrupt');
    }

    if (
      record.address &&
      !constantTimeAddressEqual(record.address, normalizedAddress)
    ) {
      return fail('challenge-address-mismatch');
    }

    const elapsedSeconds = (Date.now() - record.issuedAt) / 1000;
    if (
      !Number.isFinite(elapsedSeconds) ||
      elapsedSeconds < 0 ||
      elapsedSeconds >= this.NONCE_TTL_SECONDS
    ) {
      await this.redisService.del(key).catch(() => null);
      return fail('challenge-expired');
    }

    if (!isSiwe && record.siwe) {
      return fail('format-downgrade');
    }

    let principal: string;
    if (isSiwe) {
      principal = await this.verifySiweLogin(
        message,
        signature,
        normalizedAddress,
        record,
        fail,
      );
    } else {
      principal = this.verifyLegacyLogin(
        message,
        legacySigner as string,
        normalizedAddress,
        record,
        fail,
      );
    }

    await this.consumeChallenge(key, raw, fail);

    const user = await this.prisma.wallet.findFirst({
      where: { address: principal },
      include: { user: true },
    });
    const userId = user?.user?.id || null;

    const tokenPair = await this.tokenService.generateTokenPair(
      principal,
      userId,
    );

    return {
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      expiresIn: tokenPair.expiresIn,
      user: {
        id: userId,
        address: principal,
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

  private async verifySiweLogin(
    message: string,
    signature: string,
    normalizedAddress: string,
    record: ChallengeRecord,
    fail: (reason: string) => never,
  ): Promise<string> {
    const parsed = this.parseSiweMessageSafely(message);
    const policy = this.resolveSiwePolicy(record);
    let result: SiweVerifyResult;
    try {
      result = await this.siweService.verifySiwe({
        message,
        signature,
        expectedDomain: policy.domain,
        expectedOrigin: policy.origin,
        expectedChainId: policy.chainId,
        expectedStatement: policy.statement,
        allowedOrigins: policy.allowedOrigins,
        allowedDomains: policy.allowedDomains,
        supportedChainIds: policy.supportedChainIds,
      });
    } catch {
      return fail('siwe-verification-error');
    }
    if (!result || !result.success) {
      return fail(`siwe-${result?.error ?? 'rejected'}`);
    }

    const verifiedAddress = (
      result.address ??
      result.data?.address ??
      ''
    ).toLowerCase();
    if (
      !verifiedAddress ||
      !constantTimeAddressEqual(verifiedAddress, normalizedAddress)
    ) {
      return fail('siwe-signer-mismatch');
    }

    const embeddedAddress = (
      parsed?.address ??
      result.data?.address ??
      ''
    ).toLowerCase();
    if (
      embeddedAddress &&
      !constantTimeAddressEqual(embeddedAddress, verifiedAddress)
    ) {
      return fail('siwe-address-mismatch');
    }

    const signedNonce =
      parsed?.nonce ?? result.data?.nonce ?? this.extractNonce(message);
    if (!signedNonce || !timingSafeEqualUtf8(signedNonce, record.nonce)) {
      return fail('siwe-nonce-mismatch');
    }

    return verifiedAddress;
  }

  private verifyLegacyLogin(
    message: string,
    recoveredAddress: string,
    normalizedAddress: string,
    record: ChallengeRecord,
    fail: (reason: string) => never,
  ): string {
    if (!constantTimeAddressEqual(recoveredAddress, normalizedAddress)) {
      return fail('address-mismatch');
    }

    const expectedMessage =
      typeof this.siweService.buildLegacyMessage === 'function'
        ? this.siweService.buildLegacyMessage(record.nonce)
        : `Sign in to TruthBounty: ${record.nonce}`;
    if (!timingSafeEqualUtf8(message, expectedMessage)) {
      return fail('nonce-mismatch');
    }
    return recoveredAddress.toLowerCase();
  }

  private isSiweMessage(message: string): boolean {
    if (typeof message !== 'string') {
      return false;
    }
    const firstLine = message.split('\n')[0] ?? '';
    if (firstLine.includes(SIWE_ENVELOPE)) {
      return true;
    }
    const parsed = this.parseSiweMessageSafely(message);
    return Boolean(parsed && parsed.uri && parsed.nonce && parsed.version);
  }

  private parseSiweMessageSafely(message: string): ParsedSiweMessage | null {
    try {
      const parsed = this.siweService.parseMessage(message);
      return parsed && parsed.rawMessage?.includes(SIWE_ENVELOPE) ? parsed : null;
    } catch {
      return null;
    }
  }

  private resolveSiwePolicy(record: ChallengeRecord) {
    const get = (key: string, fallback: string): string =>
      this.configService.get<string>(key, fallback) ?? fallback;
    const domain = record.siwe?.domain ?? get('SIWE_DOMAIN', 'truthbounty.com');
    const uri =
      record.siwe?.uri ?? get('SIWE_ORIGIN', 'https://app.truthbounty.com');
    const chainId =
      record.siwe?.chainId ??
      this.parseChainIds(get('SIWE_SUPPORTED_CHAIN_IDS', '10'))[0] ??
      1;
    let origin: string;
    try {
      origin = new URL(uri).origin;
    } catch {
      origin = uri;
    }
    const statement =
      record.siwe?.statement ??
      get('SIWE_EXPECTED_STATEMENT', DEFAULT_SIWE_STATEMENT);
    const configuredChains = this.parseChainIds(
      get('SIWE_SUPPORTED_CHAIN_IDS', '10'),
    );

    return {
      domain,
      origin,
      chainId,
      statement,
      allowedOrigins: this.parseList(get('SIWE_ALLOWED_ORIGINS', '')),
      allowedDomains: this.parseList(get('SIWE_ALLOWED_DOMAINS', '')),
      supportedChainIds: Array.from(new Set([...configuredChains, chainId])),
    };
  }

  private extractNonce(message: string): string | undefined {
    if (typeof message !== 'string') {
      return undefined;
    }
    const nonceLine = message
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('Nonce:'));
    return nonceLine?.slice('Nonce:'.length).trim();
  }

  private async consumeChallenge(
    key: string,
    expectedValue: string,
    fail: (reason: string) => never,
  ): Promise<void> {
    const redis = this.redisService as RedisService & {
      consume?: (key: string, expectedValue: string) => Promise<boolean>;
    };
    if (typeof redis.consume === 'function') {
      let consumed: boolean;
      try {
        consumed = await redis.consume(key, expectedValue);
      } catch {
        return fail('challenge-consume-error');
      }
      if (!consumed) {
        return fail('challenge-already-used');
      }
      return;
    }

    let deleted: boolean;
    try {
      deleted = await this.redisService.del(key);
    } catch {
      return fail('challenge-consume-error');
    }
    if (!deleted) {
      return fail('challenge-consume-error');
    }
  }

  private parseList(raw: string | undefined): string[] {
    if (typeof raw !== 'string') {
      return [];
    }
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private parseChainIds(raw: string | undefined): number[] {
    return this.parseList(raw)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);
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

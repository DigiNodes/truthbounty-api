import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, LessThan } from 'typeorm';
import { randomBytes } from 'crypto';
import { AuthSession } from './entities/auth-session.entity';

/** Default session lifetime: 24 hours. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * V2-BE-102: Implement Session Rotation and Revocation
 *
 * Manages authenticated sessions with the following guarantees:
 *
 * - Issue: creates a new session token bound to walletAddress + chainId.
 * - Validate: returns the session or throws UnauthorizedException (fail-closed).
 * - Rotate: atomically revokes the old session and issues a new one; the new
 *   session records `rotatedFromSessionId` for audit traceability.
 * - Revoke: marks a single session as revoked.
 * - Revoke all: mass-revokes all active sessions for an address (e.g. on
 *   wallet compromise or forced logout).
 *
 * No secret values are stored. Session tokens are opaque 64-byte hex strings.
 */
@Injectable()
export class AuthSessionService {
  private readonly logger = new Logger(AuthSessionService.name);

  constructor(
    @InjectRepository(AuthSession)
    private readonly repo: Repository<AuthSession>,
  ) {}

  /** Issue a new session for a successfully authenticated wallet. */
  async issue(walletAddress: string, chainId: number): Promise<AuthSession> {
    this.assertValidAddress(walletAddress);
    this.assertValidChainId(chainId);

    const sessionToken = randomBytes(64).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    const session = this.repo.create({
      sessionToken,
      walletAddress: walletAddress.toLowerCase(),
      chainId,
      expiresAt,
      revokedAt: null,
      rotatedFromSessionId: null,
    });
    const saved = await this.repo.save(session);
    this.logger.log(`Session issued for ${walletAddress} chainId=${chainId}`);
    return saved;
  }

  /**
   * Validate a session token.
   * Throws UnauthorizedException if the token is unknown, expired, or revoked.
   */
  async validate(sessionToken: string): Promise<AuthSession> {
    const session = await this.repo.findOne({ where: { sessionToken } });

    if (!session) {
      throw new UnauthorizedException('Invalid session token');
    }
    if (session.revokedAt !== null) {
      throw new UnauthorizedException('Session has been revoked');
    }
    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException('Session has expired');
    }
    return session;
  }

  /**
   * Rotate a session: revoke the existing token and issue a fresh one.
   * The new session references the old one via rotatedFromSessionId.
   */
  async rotate(sessionToken: string): Promise<AuthSession> {
    const old = await this.validate(sessionToken);

    // Revoke old session
    old.revokedAt = new Date();
    await this.repo.save(old);

    // Issue new session
    const newToken = randomBytes(64).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    const newSession = this.repo.create({
      sessionToken: newToken,
      walletAddress: old.walletAddress,
      chainId: old.chainId,
      expiresAt,
      revokedAt: null,
      rotatedFromSessionId: old.id,
    });
    const saved = await this.repo.save(newSession);
    this.logger.log(
      `Session rotated for ${old.walletAddress} (old=${old.id} new=${saved.id})`,
    );
    return saved;
  }

  /** Revoke a single active session by token. */
  async revoke(sessionToken: string): Promise<void> {
    const session = await this.repo.findOne({ where: { sessionToken } });
    if (!session || session.revokedAt !== null) {
      // Already revoked or unknown — fail-closed, no information leak
      throw new UnauthorizedException('Session not found or already revoked');
    }
    session.revokedAt = new Date();
    await this.repo.save(session);
    this.logger.log(
      `Session revoked: ${session.id} for ${session.walletAddress}`,
    );
  }

  /**
   * Revoke all active sessions for a wallet address.
   * Used on wallet compromise, forced logout, or security events.
   */
  async revokeAll(walletAddress: string): Promise<number> {
    this.assertValidAddress(walletAddress);

    const active = await this.repo.find({
      where: {
        walletAddress: walletAddress.toLowerCase(),
        revokedAt: IsNull(),
      },
    });

    if (active.length === 0) return 0;

    const now = new Date();
    for (const s of active) s.revokedAt = now;
    await this.repo.save(active);

    this.logger.log(`Revoked ${active.length} sessions for ${walletAddress}`);
    return active.length;
  }

  /** Prune expired sessions from the database; intended for a scheduled job. */
  async pruneExpired(): Promise<number> {
    const result = await this.repo.delete({
      expiresAt: LessThan(new Date()),
    });
    return result.affected ?? 0;
  }

  private assertValidAddress(address: string): void {
    if (!address.match(/^0x[0-9a-fA-F]{40}$/)) {
      throw new BadRequestException('Invalid EVM wallet address');
    }
  }

  private assertValidChainId(chainId: number): void {
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new BadRequestException('chainId must be a positive integer');
    }
  }
}

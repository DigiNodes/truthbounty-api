import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import {
  EmailVerificationChallenge,
  EmailVerificationState,
} from '../entities/email-verification-challenge.entity';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { RedisService } from '../../redis/redis.service';

/** Raw token length in bytes → 32 bytes = 256 bits of entropy → 64 hex chars */
const TOKEN_BYTES = 32;

/** Default challenge TTL: 24 hours */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Minimum gap between resend requests (60 s) */
const RESEND_COOLDOWN_SECONDS = 60;

/** Maximum resend attempts within a sliding 1-hour window */
const RESEND_WINDOW_MAX = 5;
const RESEND_WINDOW_SECONDS = 60 * 60;

/**
 * EmailVerificationService
 *
 * Manages the full lifecycle of a notification-email ownership challenge:
 *
 *  1. `requestChallenge`  – generates a secure token, hashes and stores it,
 *                           and returns metadata for the caller to dispatch
 *                           the verification email.  Any existing PENDING
 *                           challenge for the same user is revoked first.
 *
 *  2. `confirmChallenge`  – validates the raw token against the stored hash,
 *                           checks expiry and state, marks the challenge
 *                           VERIFIED, and writes the pending address to the
 *                           user's NotificationPreference.
 *
 *  3. `getPendingChallenge` – returns the current PENDING challenge for a user
 *                             without exposing the token hash.
 *
 *  4. `getVerifiedAddress` – returns the confirmed email address for a user,
 *                             or null if none has been verified.
 *
 * Security properties:
 *  - Tokens are 256-bit random values (cryptographically strong).
 *  - Only the SHA-256 hash is persisted; the raw token is never stored.
 *  - Resend throttling is enforced per-user via Redis (falls back to DB).
 *  - Changing the pending address automatically revokes any prior challenge.
 *  - Expired challenges are treated as REVOKED for delivery-gating purposes.
 *  - Neither the token nor the full email address appears in log output.
 *  - Cross-user substitution is blocked: lookups scope on (userId, tokenHash).
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  /** TTL for a verification challenge in milliseconds */
  private readonly ttlMs: number;

  constructor(
    @InjectRepository(EmailVerificationChallenge)
    private readonly challengeRepository: Repository<EmailVerificationChallenge>,
    @InjectRepository(NotificationPreference)
    private readonly preferenceRepository: Repository<NotificationPreference>,
    private readonly configService: ConfigService,
    @Optional() private readonly redisService?: RedisService,
  ) {
    const configuredTtl = this.configService.get<number>(
      'EMAIL_VERIFICATION_TTL_MS',
    );
    this.ttlMs =
      configuredTtl && configuredTtl > 0 ? configuredTtl : DEFAULT_TTL_MS;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Issue a new ownership challenge for `newEmailAddress`.
   *
   * Returns the plaintext token (to be dispatched by the caller in a
   * verification email) and the challenge expiry.  The token is not stored —
   * only its SHA-256 hash is persisted.
   *
   * Resend throttling: a user may not request more than one challenge per
   * RESEND_COOLDOWN_SECONDS, and no more than RESEND_WINDOW_MAX challenges in
   * any RESEND_WINDOW_SECONDS sliding window.
   *
   * Address change: if `newEmailAddress` differs from the currently pending
   * address, the existing PENDING challenge is revoked before the new one is
   * issued.
   */
  async requestChallenge(
    userId: string,
    newEmailAddress: string,
  ): Promise<{ token: string; expiresAt: Date; pendingEmailAddress: string }> {
    this.assertValidEmail(newEmailAddress);

    // Resend throttle — fail before any DB write
    await this.enforceResendThrottle(userId);

    // Revoke any existing PENDING challenge for this user (address may differ)
    await this.revokeAllPending(userId);

    // Generate a fresh 256-bit random token
    const rawToken = randomBytes(TOKEN_BYTES).toString('hex');
    const tokenHash = this.hash(rawToken);
    const expiresAt = new Date(Date.now() + this.ttlMs);

    const challenge = this.challengeRepository.create({
      userId,
      tokenHash,
      pendingEmailAddress: newEmailAddress,
      state: 'PENDING',
      expiresAt,
    });
    await this.challengeRepository.save(challenge);

    // Record the resend attempt for rate-limiting purposes
    await this.recordResendAttempt(userId);

    // Log only non-sensitive metadata — no token, no email address
    this.logger.log(
      `Email verification challenge issued for user ${userId}: expiresAt=${expiresAt.toISOString()}`,
    );

    return { token: rawToken, expiresAt, pendingEmailAddress: newEmailAddress };
  }

  /**
   * Confirm a challenge by the raw plaintext token.
   *
   * On success:
   *  - The challenge row transitions to VERIFIED.
   *  - The verified address is promoted to NotificationPreference.emailAddress.
   *
   * Fail-closed on:
   *  - Missing or malformed token.
   *  - No matching PENDING challenge for this user/token combination.
   *  - Expired challenge (even if still PENDING state in DB).
   *  - Already-consumed or revoked challenge.
   */
  async confirmChallenge(
    userId: string,
    rawToken: string,
  ): Promise<{ verifiedAddress: string }> {
    if (!rawToken || typeof rawToken !== 'string' || rawToken.trim().length === 0) {
      throw new BadRequestException('Verification token is required');
    }

    const tokenHash = this.hash(rawToken.trim());

    // Look up the PENDING challenge for this user and hash — cross-user is blocked
    const challenge = await this.challengeRepository.findOne({
      where: { userId, tokenHash, state: 'PENDING' },
    });

    if (!challenge) {
      // Could be: wrong token, wrong user, already used, or revoked
      this.logger.warn(
        `Email verification failed for user ${userId}: no matching PENDING challenge`,
      );
      throw new NotFoundException(
        'Verification token is invalid, expired, or has already been used',
      );
    }

    // Explicit expiry check even if state is still PENDING
    if (challenge.expiresAt <= new Date()) {
      // Mark expired for auditing; already past deadline
      await this.challengeRepository.update(challenge.id, { state: 'EXPIRED' });
      this.logger.warn(
        `Email verification token expired for user ${userId}: challengeId=${challenge.id}`,
      );
      throw new BadRequestException(
        'Verification token has expired. Please request a new one.',
      );
    }

    // Promote to VERIFIED
    challenge.state = 'VERIFIED';
    challenge.confirmedAt = new Date();
    await this.challengeRepository.save(challenge);

    // Write the verified address to the user's notification preferences
    await this.promoteVerifiedAddress(userId, challenge.pendingEmailAddress);

    this.logger.log(
      `Email address verified for user ${userId}: challengeId=${challenge.id}`,
    );

    return { verifiedAddress: challenge.pendingEmailAddress };
  }

  /**
   * Returns the current PENDING challenge metadata (no token hash) for a
   * user, or null if none exists.
   */
  async getPendingChallenge(
    userId: string,
  ): Promise<{ expiresAt: Date; createdAt: Date } | null> {
    const challenge = await this.challengeRepository.findOne({
      where: { userId, state: 'PENDING' },
      order: { createdAt: 'DESC' },
    });

    if (!challenge || challenge.expiresAt <= new Date()) {
      return null;
    }

    return { expiresAt: challenge.expiresAt, createdAt: challenge.createdAt };
  }

  /**
   * Returns the confirmed/verified email address for a user, or null if
   * no address has been verified.  Only VERIFIED challenge rows are
   * consulted — PENDING or REVOKED rows do not constitute ownership proof.
   */
  async getVerifiedAddress(userId: string): Promise<string | null> {
    const pref = await this.preferenceRepository.findOne({
      where: { userId },
      select: ['emailAddress', 'emailAddressVerified'],
    });

    if (!pref || !pref.emailAddressVerified || !pref.emailAddress) {
      return null;
    }

    return pref.emailAddress;
  }

  /**
   * Revokes all PENDING challenges for a user without issuing a new one.
   * Intended for use when a user removes their notification email entirely.
   */
  async revokePendingChallenges(userId: string): Promise<void> {
    await this.revokeAllPending(userId);
  }

  /**
   * Expire stale challenges whose expiresAt has passed but are still PENDING.
   * Called by a scheduled maintenance job; not on the hot path.
   */
  async expireStale(): Promise<number> {
    const result = await this.challengeRepository.update(
      { state: 'PENDING', expiresAt: LessThan(new Date()) },
      { state: 'EXPIRED' },
    );
    return result.affected ?? 0;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** SHA-256 hex digest of an arbitrary string.  Never logged. */
  private hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  /** Minimal RFC-5321 format check; full validation happens at SMTP time. */
  private assertValidEmail(email: string): void {
    if (
      typeof email !== 'string' ||
      email.length < 3 ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      throw new BadRequestException('Invalid email address format');
    }
  }

  /**
   * Revoke all PENDING challenges for a user and log the count — no addresses
   * or hashes in the log message.
   */
  private async revokeAllPending(userId: string): Promise<void> {
    const result = await this.challengeRepository.update(
      { userId, state: 'PENDING' },
      { state: 'REVOKED' },
    );
    if ((result.affected ?? 0) > 0) {
      this.logger.debug(
        `Revoked ${result.affected} pending email verification challenge(s) for user ${userId}`,
      );
    }
  }

  /**
   * Enforce resend throttle.
   *
   * Two limits:
   *  1. Per-request cooldown: at most one request per RESEND_COOLDOWN_SECONDS.
   *  2. Sliding-window rate limit: at most RESEND_WINDOW_MAX per RESEND_WINDOW_SECONDS.
   *
   * Redis is the primary store; falls back to DB count on unavailability.
   */
  private async enforceResendThrottle(userId: string): Promise<void> {
    const cooldownKey = `email_verif:cooldown:${userId}`;
    const windowKey = `email_verif:window:${userId}`;

    if (this.redisService) {
      // ── Cooldown ────────────────────────────────────────────────────────
      const cooldownExists = await this.redisService.get(cooldownKey);
      if (cooldownExists) {
        throw new ConflictException(
          `Please wait ${RESEND_COOLDOWN_SECONDS} seconds before requesting another verification email`,
        );
      }

      // ── Sliding window ──────────────────────────────────────────────────
      const windowRaw = await this.redisService.get(windowKey);
      const windowCount = windowRaw ? parseInt(windowRaw, 10) : 0;
      if (windowCount >= RESEND_WINDOW_MAX) {
        throw new ConflictException(
          'Too many verification email requests. Please try again later.',
        );
      }
    } else {
      // DB fallback: count all challenges created within the sliding window
      const windowStart = new Date(Date.now() - RESEND_WINDOW_SECONDS * 1000);
      // Simplified DB fallback just counts all recent challenges in the window
      const recentCount = await this.challengeRepository
        .createQueryBuilder('c')
        .where('c.userId = :userId', { userId })
        .andWhere('c.createdAt >= :windowStart', { windowStart })
        .getCount();

      if (recentCount >= RESEND_WINDOW_MAX) {
        throw new ConflictException(
          'Too many verification email requests. Please try again later.',
        );
      }

      // Cooldown fallback: check if any challenge was created in the last
      // RESEND_COOLDOWN_SECONDS
      const cooldownStart = new Date(Date.now() - RESEND_COOLDOWN_SECONDS * 1000);
      const recentlyCooldown = await this.challengeRepository
        .createQueryBuilder('c')
        .where('c.userId = :userId', { userId })
        .andWhere('c.createdAt >= :cooldownStart', { cooldownStart })
        .getCount();

      if (recentlyCooldown > 0) {
        throw new ConflictException(
          `Please wait ${RESEND_COOLDOWN_SECONDS} seconds before requesting another verification email`,
        );
      }
    }
  }

  /**
   * Record a resend attempt for future throttle checks.
   * Uses Redis INCR + EXPIRE for the sliding window and SETNX for the
   * per-request cooldown.  Best-effort — throttle writes are advisory and
   * never fail the main request path.
   */
  private async recordResendAttempt(userId: string): Promise<void> {
    if (!this.redisService) return;

    try {
      const cooldownKey = `email_verif:cooldown:${userId}`;
      const windowKey = `email_verif:window:${userId}`;

      // Set cooldown key (NX, expires in RESEND_COOLDOWN_SECONDS)
      await this.redisService.setnx(cooldownKey, '1', RESEND_COOLDOWN_SECONDS);

      // Increment window counter
      const script = `
        local key     = KEYS[1]
        local expiry  = tonumber(ARGV[1])
        local current = redis.call('INCR', key)
        if current == 1 then
          redis.call('EXPIRE', key, expiry)
        end
        return current
      `;
      await this.redisService.eval(
        script,
        1,
        windowKey,
        String(RESEND_WINDOW_SECONDS),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to record resend attempt for user ${userId}: ${(err as Error).message}`,
      );
      // Non-fatal — throttle remains advisory
    }
  }

  /**
   * Write the confirmed address to the user's notification preferences and
   * mark it as verified.  Creates a preference row if one does not exist.
   */
  private async promoteVerifiedAddress(
    userId: string,
    address: string,
  ): Promise<void> {
    let pref = await this.preferenceRepository.findOne({ where: { userId } });

    if (!pref) {
      pref = this.preferenceRepository.create({ userId });
    }

    pref.emailAddress = address;
    pref.emailAddressVerified = true;
    pref.lastModifiedAt = new Date();

    await this.preferenceRepository.save(pref);
  }
}

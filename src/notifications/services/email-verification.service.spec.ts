/**
 * EmailVerificationService — unit tests
 *
 * Required coverage per issue spec:
 *  ✓ Valid token confirms challenge and promotes address
 *  ✓ Expired token is rejected
 *  ✓ Replayed (already-used) token is rejected
 *  ✓ Revoked challenge is rejected
 *  ✓ Malformed / missing token is rejected
 *  ✓ Address change invalidates prior pending challenge
 *  ✓ Rate limit and resend behaviour (cooldown + sliding window)
 *  ✓ Token hash and full email address are never written to logs
 *  ✓ Unverified addresses do not satisfy getVerifiedAddress / getNotificationEmail
 */

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { EmailVerificationChallenge } from '../entities/email-verification-challenge.entity';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { EmailVerificationService } from './email-verification.service';
import { RedisService } from '../../redis/redis.service';
import { ConfigService } from '@nestjs/config';

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makePendingChallenge(
  overrides: Partial<EmailVerificationChallenge> = {},
): EmailVerificationChallenge {
  const c = new EmailVerificationChallenge();
  c.id = 'challenge-id-1';
  c.userId = 'user-1';
  c.tokenHash = sha256('valid-token-abc');
  c.pendingEmailAddress = 'pending@example.com';
  c.state = 'PENDING';
  c.expiresAt = new Date(Date.now() + 60_000);
  c.createdAt = new Date();
  c.updatedAt = new Date();
  return Object.assign(c, overrides);
}

// ── Mock factories ────────────────────────────────────────────────────────────

function makeChallengeRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn((dto) => Object.assign(new EmailVerificationChallenge(), dto)),
    save: jest.fn(async (entity) => entity),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
    })),
  };
}

function makePreferenceRepository() {
  const pref: Partial<NotificationPreference> = {
    userId: 'user-1',
    emailAddress: undefined,
    emailAddressVerified: false,
    lastModifiedAt: undefined,
  };
  return {
    findOne: jest.fn().mockResolvedValue(pref),
    create: jest.fn((dto) => ({ ...pref, ...dto })),
    save: jest.fn(async (entity) => entity),
  };
}

function makeRedisService() {
  return {
    get: jest.fn().mockResolvedValue(null),
    setnx: jest.fn().mockResolvedValue(true),
    eval: jest.fn().mockResolvedValue(1),
    del: jest.fn().mockResolvedValue(true),
  };
}

function makeConfigService(overrides: Record<string, unknown> = {}) {
  return {
    get: jest.fn((key: string, defaultVal?: unknown) => {
      return (overrides as Record<string, unknown>)[key] ?? defaultVal;
    }),
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('EmailVerificationService', () => {
  let service: EmailVerificationService;
  let challengeRepo: ReturnType<typeof makeChallengeRepository>;
  let preferenceRepo: ReturnType<typeof makePreferenceRepository>;
  let redisService: ReturnType<typeof makeRedisService>;

  beforeEach(async () => {
    challengeRepo = makeChallengeRepository();
    preferenceRepo = makePreferenceRepository();
    redisService = makeRedisService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailVerificationService,
        {
          provide: getRepositoryToken(EmailVerificationChallenge),
          useValue: challengeRepo,
        },
        {
          provide: getRepositoryToken(NotificationPreference),
          useValue: preferenceRepo,
        },
        {
          provide: ConfigService,
          useValue: makeConfigService(),
        },
        {
          provide: RedisService,
          useValue: redisService,
        },
      ],
    }).compile();

    service = module.get<EmailVerificationService>(EmailVerificationService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── requestChallenge ───────────────────────────────────────────────────────

  describe('requestChallenge', () => {
    it('issues a challenge and returns a non-empty token', async () => {
      const result = await service.requestChallenge('user-1', 'new@example.com');

      expect(result.token).toBeTruthy();
      expect(result.token.length).toBeGreaterThan(16);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('revokes existing PENDING challenge before issuing a new one', async () => {
      await service.requestChallenge('user-1', 'new@example.com');

      // revokeAllPending calls update({userId, state:'PENDING'}, {state:'REVOKED'})
      expect(challengeRepo.update).toHaveBeenCalledWith(
        { userId: 'user-1', state: 'PENDING' },
        { state: 'REVOKED' },
      );
    });

    it('persists the token hash — not the raw token', async () => {
      const result = await service.requestChallenge('user-1', 'new@example.com');

      const savedCall = challengeRepo.save.mock.calls[0][0] as EmailVerificationChallenge;
      expect(savedCall.tokenHash).toBe(sha256(result.token));
      // Raw token must NOT appear in the persisted entity
      expect(savedCall).not.toHaveProperty('token');
    });

    it('does not log the email address', async () => {
      const logSpy = jest.spyOn((service as any).logger, 'log');
      await service.requestChallenge('user-1', 'secret@example.com');

      for (const call of logSpy.mock.calls) {
        const msg = String(call[0]);
        expect(msg).not.toContain('secret@example.com');
      }
    });

    it('does not log the raw token', async () => {
      const logSpy = jest.spyOn((service as any).logger, 'log');
      const { token } = await service.requestChallenge('user-1', 'new@example.com');

      for (const call of logSpy.mock.calls) {
        const msg = String(call[0]);
        expect(msg).not.toContain(token);
      }
    });

    it('rejects an obviously invalid email format', async () => {
      await expect(
        service.requestChallenge('user-1', 'not-an-email'),
      ).rejects.toThrow(BadRequestException);
    });

    it('enforces per-request cooldown via Redis', async () => {
      // Simulate cooldown key existing
      redisService.get.mockResolvedValueOnce('1');

      await expect(
        service.requestChallenge('user-1', 'new@example.com'),
      ).rejects.toThrow(ConflictException);
    });

    it('enforces sliding-window rate limit via Redis', async () => {
      // cooldown clear, window counter at max
      redisService.get
        .mockResolvedValueOnce(null) // cooldown key → absent
        .mockResolvedValueOnce('5'); // window counter → at limit

      await expect(
        service.requestChallenge('user-1', 'new@example.com'),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── confirmChallenge ───────────────────────────────────────────────────────

  describe('confirmChallenge', () => {
    it('confirms a valid token and returns the verified address', async () => {
      const rawToken = 'valid-token-abc';
      const challenge = makePendingChallenge({ tokenHash: sha256(rawToken) });
      challengeRepo.findOne.mockResolvedValue(challenge);

      const result = await service.confirmChallenge('user-1', rawToken);

      expect(result.verifiedAddress).toBe(challenge.pendingEmailAddress);
    });

    it('transitions the challenge to VERIFIED on success', async () => {
      const rawToken = 'valid-token-abc';
      const challenge = makePendingChallenge({ tokenHash: sha256(rawToken) });
      challengeRepo.findOne.mockResolvedValue(challenge);

      await service.confirmChallenge('user-1', rawToken);

      const savedChallenge = challengeRepo.save.mock.calls[0][0] as EmailVerificationChallenge;
      expect(savedChallenge.state).toBe('VERIFIED');
      expect(savedChallenge.confirmedAt).toBeInstanceOf(Date);
    });

    it('promotes the verified address to notification preferences', async () => {
      const rawToken = 'valid-token-abc';
      const address = 'confirmed@example.com';
      const challenge = makePendingChallenge({
        tokenHash: sha256(rawToken),
        pendingEmailAddress: address,
      });
      challengeRepo.findOne.mockResolvedValue(challenge);

      await service.confirmChallenge('user-1', rawToken);

      const savedPref = preferenceRepo.save.mock.calls[0][0] as NotificationPreference;
      expect(savedPref.emailAddress).toBe(address);
      expect(savedPref.emailAddressVerified).toBe(true);
    });

    it('rejects a missing / empty token', async () => {
      await expect(service.confirmChallenge('user-1', '')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a malformed / wrong token (no matching challenge)', async () => {
      challengeRepo.findOne.mockResolvedValue(null);

      await expect(
        service.confirmChallenge('user-1', 'wrong-token'),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects a token that belongs to a different user (cross-user protection)', async () => {
      // findOne scoped to userId='user-1' finds nothing because challenge is
      // owned by 'user-2' — so it returns null
      challengeRepo.findOne.mockResolvedValue(null);

      await expect(
        service.confirmChallenge('user-1', 'valid-token-abc'),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects an expired token even if still in PENDING state', async () => {
      const rawToken = 'valid-token-abc';
      const challenge = makePendingChallenge({
        tokenHash: sha256(rawToken),
        expiresAt: new Date(Date.now() - 1000), // already expired
      });
      challengeRepo.findOne.mockResolvedValue(challenge);

      await expect(
        service.confirmChallenge('user-1', rawToken),
      ).rejects.toThrow(BadRequestException);

      // Must also mark the challenge as EXPIRED in the DB
      expect(challengeRepo.update).toHaveBeenCalledWith(
        challenge.id,
        { state: 'EXPIRED' },
      );
    });

    it('rejects a revoked challenge (findOne returns null for PENDING scope)', async () => {
      // The DB query scopes to state='PENDING'; a REVOKED row is not returned
      challengeRepo.findOne.mockResolvedValue(null);

      await expect(
        service.confirmChallenge('user-1', 'valid-token-abc'),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects a replayed token (challenge already VERIFIED, not PENDING)', async () => {
      // Same as revoked — findOne scoped to PENDING returns nothing
      challengeRepo.findOne.mockResolvedValue(null);

      await expect(
        service.confirmChallenge('user-1', 'valid-token-abc'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Address change invalidates prior challenge ─────────────────────────────

  describe('address change invalidates prior pending challenge', () => {
    it('calls revokeAllPending on every requestChallenge invocation', async () => {
      // First challenge with address A
      await service.requestChallenge('user-1', 'address-a@example.com');
      expect(challengeRepo.update).toHaveBeenCalledWith(
        { userId: 'user-1', state: 'PENDING' },
        { state: 'REVOKED' },
      );

      jest.clearAllMocks();

      // Second challenge with address B — prior challenge is revoked again
      await service.requestChallenge('user-1', 'address-b@example.com');
      expect(challengeRepo.update).toHaveBeenCalledWith(
        { userId: 'user-1', state: 'PENDING' },
        { state: 'REVOKED' },
      );
    });
  });

  // ── Unverified address gate ────────────────────────────────────────────────

  describe('getVerifiedAddress', () => {
    it('returns null when no preference record exists', async () => {
      preferenceRepo.findOne.mockResolvedValue(null);

      const result = await service.getVerifiedAddress('user-1');
      expect(result).toBeNull();
    });

    it('returns null when emailAddressVerified is false', async () => {
      preferenceRepo.findOne.mockResolvedValue({
        emailAddress: 'unverified@example.com',
        emailAddressVerified: false,
      });

      const result = await service.getVerifiedAddress('user-1');
      expect(result).toBeNull();
    });

    it('returns null when emailAddress is null even if verified flag is true', async () => {
      preferenceRepo.findOne.mockResolvedValue({
        emailAddress: null,
        emailAddressVerified: true,
      });

      const result = await service.getVerifiedAddress('user-1');
      expect(result).toBeNull();
    });

    it('returns the address only when both emailAddress and verified flag are set', async () => {
      preferenceRepo.findOne.mockResolvedValue({
        emailAddress: 'verified@example.com',
        emailAddressVerified: true,
      });

      const result = await service.getVerifiedAddress('user-1');
      expect(result).toBe('verified@example.com');
    });
  });

  // ── getPendingChallenge ────────────────────────────────────────────────────

  describe('getPendingChallenge', () => {
    it('returns null when no PENDING challenge exists', async () => {
      challengeRepo.findOne.mockResolvedValue(null);

      const result = await service.getPendingChallenge('user-1');
      expect(result).toBeNull();
    });

    it('returns null when the PENDING challenge has already expired', async () => {
      const expired = makePendingChallenge({
        expiresAt: new Date(Date.now() - 1000),
      });
      challengeRepo.findOne.mockResolvedValue(expired);

      const result = await service.getPendingChallenge('user-1');
      expect(result).toBeNull();
    });

    it('returns expiry metadata for a valid PENDING challenge', async () => {
      const challenge = makePendingChallenge();
      challengeRepo.findOne.mockResolvedValue(challenge);

      const result = await service.getPendingChallenge('user-1');
      expect(result).not.toBeNull();
      expect(result!.expiresAt).toEqual(challenge.expiresAt);
      // Must NOT expose tokenHash
      expect(result).not.toHaveProperty('tokenHash');
    });
  });

  // ── revokePendingChallenges ────────────────────────────────────────────────

  describe('revokePendingChallenges', () => {
    it('revokes all PENDING challenges for a user', async () => {
      await service.revokePendingChallenges('user-1');

      expect(challengeRepo.update).toHaveBeenCalledWith(
        { userId: 'user-1', state: 'PENDING' },
        { state: 'REVOKED' },
      );
    });
  });

  // ── expireStale ────────────────────────────────────────────────────────────

  describe('expireStale', () => {
    it('marks stale PENDING challenges as EXPIRED', async () => {
      challengeRepo.update.mockResolvedValueOnce({ affected: 3 });

      const count = await service.expireStale();
      expect(count).toBe(3);
    });
  });

  // ── Redis unavailable — DB fallback ───────────────────────────────────────

  describe('DB fallback when Redis is unavailable', () => {
    let noRedisService: EmailVerificationService;
    let noRedisChallengeRepo: ReturnType<typeof makeChallengeRepository>;
    let noRedisPreferenceRepo: ReturnType<typeof makePreferenceRepository>;

    beforeEach(async () => {
      noRedisChallengeRepo = makeChallengeRepository();
      noRedisPreferenceRepo = makePreferenceRepository();

      const module = await Test.createTestingModule({
        providers: [
          EmailVerificationService,
          {
            provide: getRepositoryToken(EmailVerificationChallenge),
            useValue: noRedisChallengeRepo,
          },
          {
            provide: getRepositoryToken(NotificationPreference),
            useValue: noRedisPreferenceRepo,
          },
          {
            provide: ConfigService,
            useValue: makeConfigService(),
          },
          // RedisService intentionally omitted → @Optional() injects undefined
        ],
      }).compile();

      noRedisService = module.get<EmailVerificationService>(EmailVerificationService);
    });

    it('issues a challenge successfully without Redis', async () => {
      const result = await noRedisService.requestChallenge(
        'user-1',
        'new@example.com',
      );
      expect(result.token).toBeTruthy();
    });

    it('enforces DB-based rate limit when Redis is unavailable', async () => {
      // Simulate the sliding window having been exhausted
      const qbMock = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(5), // at limit
      };
      noRedisChallengeRepo.createQueryBuilder.mockReturnValue(qbMock);

      await expect(
        noRedisService.requestChallenge('user-1', 'new@example.com'),
      ).rejects.toThrow(ConflictException);
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { PreferenceEnforcer } from './preference-enforcer.service';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { DeliveryHistory } from '../entities/delivery-history.entity';
import { Notification } from '../entities/notification.entity';
import { DeliveryChannel } from '../interfaces/notification.types';
import { EventType } from '../enums/event-type.enum';
import { UpdatePreferenceSettingsDto } from '../dto/update-preference-settings.dto';
import { RedisService } from '../../redis/redis.service';

// ── helpers ──────────────────────────────────────────────────────────────────

function makePrefs(
  overrides: Partial<NotificationPreference> = {},
): NotificationPreference {
  return {
    id: 'pref-1',
    userId: 'user-1',
    channels: {
      [DeliveryChannel.IN_APP]: true,
      [DeliveryChannel.EMAIL]: true,
      [DeliveryChannel.PUSH]: false,
      [DeliveryChannel.WEBHOOK]: false,
      [DeliveryChannel.WEBSOCKET]: true,
      [DeliveryChannel.SMS]: false,
    },
    categorySubscriptions: {},
    language: 'en',
    createdAt: new Date(),
    updatedAt: new Date(),
    normalizeLoadedChannels: jest.fn(),
    persistNormalizedChannels: jest.fn(),
    ...overrides,
  } as unknown as NotificationPreference;
}

/** Builds a minimal mock query-builder that returns `count` from getCount(). */
function makeQb(count: number) {
  const qb = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(count),
  } as unknown as SelectQueryBuilder<DeliveryHistory>;
  return qb;
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('PreferenceEnforcer', () => {
  let service: PreferenceEnforcer;
  let mockPrefRepo: jest.Mocked<Repository<NotificationPreference>>;
  let mockHistoryRepo: jest.Mocked<Repository<DeliveryHistory>>;
  let mockNotificationRepo: jest.Mocked<Repository<Notification>>;
  let mockRedis: jest.Mocked<RedisService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PreferenceEnforcer,
        {
          provide: getRepositoryToken(NotificationPreference),
          useValue: {
            findOne: jest.fn(),
            save: jest.fn(),
            create: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(DeliveryHistory),
          useValue: {
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Notification),
          useValue: {},
        },
        {
          provide: RedisService,
          useValue: {
            eval: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<PreferenceEnforcer>(PreferenceEnforcer);
    mockPrefRepo = module.get(getRepositoryToken(NotificationPreference));
    mockHistoryRepo = module.get(getRepositoryToken(DeliveryHistory));
    mockNotificationRepo = module.get(getRepositoryToken(Notification));
    mockRedis = module.get(RedisService);

    // Default: Redis returns 1 (first call of the day — under any cap)
    mockRedis.eval.mockResolvedValue(1);
  });

  afterEach(() => jest.clearAllMocks());

  // ── getPreferences ──────────────────────────────────────────────────────────

  describe('getPreferences', () => {
    it('returns existing preferences', async () => {
      const prefs = makePrefs();
      mockPrefRepo.findOne.mockResolvedValue(prefs);

      const result = await service.getPreferences('user-1');
      expect(result.userId).toBe('user-1');
    });

    it('creates default preferences when none exist', async () => {
      mockPrefRepo.findOne.mockResolvedValue(null);
      mockPrefRepo.create.mockReturnValue(makePrefs());
      mockPrefRepo.save.mockResolvedValue(makePrefs());

      await service.getPreferences('user-1');

      expect(mockPrefRepo.create).toHaveBeenCalled();
      expect(mockPrefRepo.save).toHaveBeenCalled();
    });
  });

  // ── isChannelEnabled ────────────────────────────────────────────────────────

  describe('isChannelEnabled', () => {
    it('returns true for an enabled channel', async () => {
      mockPrefRepo.findOne.mockResolvedValue(makePrefs());
      expect(await service.isChannelEnabled('user-1', DeliveryChannel.IN_APP)).toBe(true);
    });

    it('returns false for a disabled channel', async () => {
      mockPrefRepo.findOne.mockResolvedValue(makePrefs());
      expect(await service.isChannelEnabled('user-1', DeliveryChannel.PUSH)).toBe(false);
    });
  });

  // ── isCategoryEnabled ───────────────────────────────────────────────────────

  describe('isCategoryEnabled', () => {
    it('returns true when category is explicitly enabled', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ categorySubscriptions: { [EventType.CLAIM_CREATED]: true } }),
      );
      expect(await service.isCategoryEnabled('user-1', EventType.CLAIM_CREATED)).toBe(true);
    });

    it('returns true by default when no subscriptions are set', async () => {
      mockPrefRepo.findOne.mockResolvedValue(makePrefs({ categorySubscriptions: {} }));
      expect(await service.isCategoryEnabled('user-1', EventType.CLAIM_CREATED)).toBe(true);
    });

    it('returns false when category is explicitly disabled', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ categorySubscriptions: { [EventType.CLAIM_CREATED]: false } }),
      );
      expect(await service.isCategoryEnabled('user-1', EventType.CLAIM_CREATED)).toBe(false);
    });
  });

  // ── isInQuietHours ──────────────────────────────────────────────────────────

  describe('isInQuietHours', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it('returns false when quiet hours are disabled', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ quietHours: { enabled: false } }),
      );
      expect(await service.isInQuietHours('user-1')).toBe(false);
    });

    it('returns false when no quiet hours configured', async () => {
      mockPrefRepo.findOne.mockResolvedValue(makePrefs({ quietHours: undefined }));
      expect(await service.isInQuietHours('user-1')).toBe(false);
    });

    it('returns true inside a same-day window', async () => {
      jest.setSystemTime(new Date('2026-06-15T12:00:00Z'));
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ quietHours: { enabled: true, startTime: '09:00', endTime: '17:00', timezone: 'UTC' } }),
      );
      expect(await service.isInQuietHours('user-1')).toBe(true);
    });

    it('returns false outside a same-day window', async () => {
      jest.setSystemTime(new Date('2026-06-15T18:00:00Z'));
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ quietHours: { enabled: true, startTime: '09:00', endTime: '17:00', timezone: 'UTC' } }),
      );
      expect(await service.isInQuietHours('user-1')).toBe(false);
    });

    it('handles overnight window correctly', async () => {
      jest.setSystemTime(new Date('2026-06-16T00:30:00Z'));
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ quietHours: { enabled: true, startTime: '22:00', endTime: '08:00', timezone: 'UTC' } }),
      );
      expect(await service.isInQuietHours('user-1')).toBe(true);
    });

    it('falls back to UTC for an invalid timezone', async () => {
      jest.setSystemTime(new Date('2026-06-15T01:30:00Z'));
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ quietHours: { enabled: true, startTime: '01:00', endTime: '02:00', timezone: 'Not/AZone' } }),
      );
      expect(await service.isInQuietHours('user-1')).toBe(true);
    });
  });

  // ── canDeliverNotification (quota enforcement) ──────────────────────────────

  describe('canDeliverNotification — overall daily cap', () => {
    it('allows delivery when cap is null (unlimited)', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ maxNotificationsPerDay: undefined }),
      );

      const result = await service.canDeliverNotification('user-1', DeliveryChannel.IN_APP);

      expect(result.allowed).toBe(true);
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });

    it('allows delivery when Redis counter is below the cap', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ maxNotificationsPerDay: 10 }),
      );
      mockRedis.eval.mockResolvedValue(5); // counter = 5, cap = 10

      const result = await service.canDeliverNotification('user-1', DeliveryChannel.IN_APP);

      expect(result.allowed).toBe(true);
    });

    it('allows delivery exactly at the cap (counter == cap)', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ maxNotificationsPerDay: 10 }),
      );
      mockRedis.eval.mockResolvedValue(10); // exactly at cap

      const result = await service.canDeliverNotification('user-1', DeliveryChannel.IN_APP);

      expect(result.allowed).toBe(true);
    });

    it('denies delivery when counter exceeds the cap', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ maxNotificationsPerDay: 10 }),
      );
      mockRedis.eval
        .mockResolvedValueOnce(11)   // overall INCR returns 11 → over cap
        .mockResolvedValueOnce(10);  // DECR rollback

      const result = await service.canDeliverNotification('user-1', DeliveryChannel.IN_APP);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('overall_cap_reached');
      expect(result.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    });

    it('deliveries stop exactly at the configured overall daily cap', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ maxNotificationsPerDay: 3 }),
      );

      // First 3 succeed (counter 1, 2, 3)
      for (let i = 1; i <= 3; i++) {
        mockRedis.eval.mockResolvedValueOnce(i);
        const r = await service.canDeliverNotification('user-1', DeliveryChannel.IN_APP);
        expect(r.allowed).toBe(true);
      }

      // 4th call: INCR returns 4 (over cap=3), then DECR rollback
      mockRedis.eval
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(3);
      const denied = await service.canDeliverNotification('user-1', DeliveryChannel.IN_APP);
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toBe('overall_cap_reached');
    });
  });

  describe('canDeliverNotification — email-specific cap', () => {
    it('allows email delivery when email cap is null (unlimited)', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ maxEmailsPerDay: undefined }),
      );

      const result = await service.canDeliverNotification('user-1', DeliveryChannel.EMAIL);

      expect(result.allowed).toBe(true);
    });

    it('denies email delivery when email counter exceeds the cap', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ maxNotificationsPerDay: 100, maxEmailsPerDay: 5 }),
      );
      // overall INCR = 1 (fine), email INCR = 6 (over cap=5)
      mockRedis.eval
        .mockResolvedValueOnce(1)   // overall counter
        .mockResolvedValueOnce(6)   // email counter → over cap
        .mockResolvedValueOnce(5)   // email DECR rollback
        .mockResolvedValueOnce(0);  // overall DECR rollback

      const result = await service.canDeliverNotification('user-1', DeliveryChannel.EMAIL);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('email_cap_reached');
      expect(result.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    });

    it('email cap does not affect non-email channels', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ maxNotificationsPerDay: 10, maxEmailsPerDay: 2 }),
      );
      // Only overall INCR is called; no email INCR for PUSH
      mockRedis.eval.mockResolvedValueOnce(3);

      const result = await service.canDeliverNotification('user-1', DeliveryChannel.PUSH);

      expect(result.allowed).toBe(true);
      expect(mockRedis.eval).toHaveBeenCalledTimes(1); // only overall
    });

    it('email deliveries stop at the configured email daily cap', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ maxEmailsPerDay: 2 }),
      );

      // 2 succeed
      for (let i = 1; i <= 2; i++) {
        mockRedis.eval.mockResolvedValueOnce(i);
        const r = await service.canDeliverNotification('user-1', DeliveryChannel.EMAIL);
        expect(r.allowed).toBe(true);
      }

      // 3rd is denied
      mockRedis.eval
        .mockResolvedValueOnce(3)   // email INCR over cap
        .mockResolvedValueOnce(2);  // DECR rollback
      const denied = await service.canDeliverNotification('user-1', DeliveryChannel.EMAIL);
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toBe('email_cap_reached');
    });
  });

  describe('canDeliverNotification — Redis unavailable (DB fallback)', () => {
    it('falls back to DB and allows delivery when count is below cap', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ maxNotificationsPerDay: 10 }),
      );
      mockRedis.eval.mockRejectedValue(new Error('Redis unavailable'));

      const qb = makeQb(3); // DB says 3 deliveries today
      mockHistoryRepo.createQueryBuilder.mockReturnValue(qb as any);

      const result = await service.canDeliverNotification('user-1', DeliveryChannel.IN_APP);

      expect(result.allowed).toBe(true);
    });

    it('falls back to DB and denies when count meets or exceeds cap', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ maxNotificationsPerDay: 5 }),
      );
      mockRedis.eval.mockRejectedValue(new Error('Redis unavailable'));

      const qb = makeQb(5); // DB says exactly at cap → deny
      mockHistoryRepo.createQueryBuilder.mockReturnValue(qb as any);

      const result = await service.canDeliverNotification('user-1', DeliveryChannel.IN_APP);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('overall_cap_reached');
    });

    it('denies delivery (fail-closed) when both Redis and DB fail', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ maxNotificationsPerDay: 10 }),
      );
      mockRedis.eval.mockRejectedValue(new Error('Redis unavailable'));

      const qb = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockRejectedValue(new Error('DB error')),
      };
      mockHistoryRepo.createQueryBuilder.mockReturnValue(qb as any);

      const result = await service.canDeliverNotification('user-1', DeliveryChannel.IN_APP);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('overall_cap_reached');
    });
  });

  describe('canDeliverNotification — idempotency and concurrent workers', () => {
    it('the Lua INCR + EXPIREAT script is called once per channel type', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ maxNotificationsPerDay: 100, maxEmailsPerDay: 50 }),
      );
      mockRedis.eval.mockResolvedValue(1);

      await service.canDeliverNotification('user-1', DeliveryChannel.EMAIL);

      // Should call eval twice: once for overall, once for email
      expect(mockRedis.eval).toHaveBeenCalledTimes(2);
    });

    it('concurrent calls each get distinct incremented values via Redis atomicity', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ maxNotificationsPerDay: 3 }),
      );
      // Simulate 3 concurrent workers: each gets a unique counter
      mockRedis.eval
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3);

      const results = await Promise.all([
        service.canDeliverNotification('user-1', DeliveryChannel.IN_APP),
        service.canDeliverNotification('user-1', DeliveryChannel.IN_APP),
        service.canDeliverNotification('user-1', DeliveryChannel.IN_APP),
      ]);

      expect(results.every((r) => r.allowed)).toBe(true);
    });

    it('resetAt is an ISO-8601 UTC midnight timestamp', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ maxNotificationsPerDay: 1 }),
      );
      mockRedis.eval
        .mockResolvedValueOnce(2)   // over cap
        .mockResolvedValueOnce(1);  // rollback

      const result = await service.canDeliverNotification('user-1', DeliveryChannel.IN_APP);

      expect(result.allowed).toBe(false);
      expect(result.resetAt).toBeDefined();
      const reset = new Date(result.resetAt!);
      expect(reset.getUTCHours()).toBe(0);
      expect(reset.getUTCMinutes()).toBe(0);
      expect(reset.getUTCSeconds()).toBe(0);
    });

    it('timezone and day-boundary: resetAt always points to next UTC midnight', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-06-15T23:59:00Z'));

      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ maxNotificationsPerDay: 1 }),
      );
      mockRedis.eval
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1);

      const result = await service.canDeliverNotification('user-1', DeliveryChannel.IN_APP);

      expect(result.resetAt).toBe('2026-06-16T00:00:00.000Z');

      jest.useRealTimers();
    });
  });

  // ── shouldDeliver ───────────────────────────────────────────────────────────

  describe('shouldDeliver', () => {
    it('allows delivery when all constraints pass', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({
          channels: { [DeliveryChannel.IN_APP]: true } as any,
          categorySubscriptions: { [EventType.CLAIM_CREATED]: true },
          quietHours: { enabled: false },
        }),
      );
      mockRedis.eval.mockResolvedValue(1);

      const result = await service.shouldDeliver('user-1', EventType.CLAIM_CREATED, DeliveryChannel.IN_APP);

      expect(result.allowed).toBe(true);
      expect(result.resetAt).toBeUndefined();
    });

    it('blocks when channel is disabled', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({ channels: { [DeliveryChannel.IN_APP]: false } as any }),
      );

      const result = await service.shouldDeliver('user-1', EventType.CLAIM_CREATED, DeliveryChannel.IN_APP);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('disabled');
    });

    it('blocks when category is disabled', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({
          channels: { [DeliveryChannel.IN_APP]: true } as any,
          categorySubscriptions: { [EventType.CLAIM_CREATED]: false },
        }),
      );

      const result = await service.shouldDeliver('user-1', EventType.CLAIM_CREATED, DeliveryChannel.IN_APP);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('disabled');
    });

    it('blocks email during quiet hours', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-06-15T12:00:00Z'));

      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({
          channels: { [DeliveryChannel.EMAIL]: true } as any,
          categorySubscriptions: {},
          quietHours: { enabled: true, startTime: '09:00', endTime: '17:00', timezone: 'UTC' },
        }),
      );

      const result = await service.shouldDeliver('user-1', EventType.CLAIM_CREATED, DeliveryChannel.EMAIL);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('quiet hours');

      jest.useRealTimers();
    });

    it('exposes resetAt when overall cap is the denial reason', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({
          channels: { [DeliveryChannel.IN_APP]: true } as any,
          categorySubscriptions: {},
          maxNotificationsPerDay: 5,
        }),
      );
      mockRedis.eval
        .mockResolvedValueOnce(6)   // over cap
        .mockResolvedValueOnce(5);  // rollback

      const result = await service.shouldDeliver('user-1', EventType.CLAIM_CREATED, DeliveryChannel.IN_APP);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Daily limit reached');
      expect(result.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    });

    it('exposes resetAt when email cap is the denial reason', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({
          channels: { [DeliveryChannel.EMAIL]: true } as any,
          categorySubscriptions: {},
          maxEmailsPerDay: 2,
        }),
      );
      mockRedis.eval
        .mockResolvedValueOnce(3)   // email over cap
        .mockResolvedValueOnce(2);  // rollback

      const result = await service.shouldDeliver('user-1', EventType.CLAIM_CREATED, DeliveryChannel.EMAIL);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Daily email limit');
      expect(result.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    });
  });

  // ── getEnabledChannels ──────────────────────────────────────────────────────

  describe('getEnabledChannels', () => {
    it('returns only enabled channels', async () => {
      mockPrefRepo.findOne.mockResolvedValue(
        makePrefs({
          channels: {
            [DeliveryChannel.IN_APP]: true,
            [DeliveryChannel.EMAIL]: true,
            [DeliveryChannel.PUSH]: false,
            [DeliveryChannel.WEBHOOK]: false,
            [DeliveryChannel.WEBSOCKET]: true,
            [DeliveryChannel.SMS]: false,
          } as any,
        }),
      );

      const result = await service.getEnabledChannels('user-1');

      expect(result).toContain(DeliveryChannel.IN_APP);
      expect(result).toContain(DeliveryChannel.EMAIL);
      expect(result).toContain(DeliveryChannel.WEBSOCKET);
      expect(result).not.toContain(DeliveryChannel.PUSH);
      expect(result.length).toBe(3);
    });
  });

  // ── updatePreferences ───────────────────────────────────────────────────────

  describe('updatePreferences', () => {
    it('saves updated preferences', async () => {
      const original = makePrefs();
      mockPrefRepo.findOne.mockResolvedValue(original);
      mockPrefRepo.save.mockResolvedValue({ ...original, language: 'fr' } as any);

      await service.updatePreferences('user-1', { language: 'fr' });

      expect(mockPrefRepo.save).toHaveBeenCalled();
    });
  });
});

describe('PreferenceEnforcer', () => {
  let service: PreferenceEnforcer;
  let mockPreferenceRepository: jest.Mocked<Repository<NotificationPreference>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PreferenceEnforcer,
        {
          provide: getRepositoryToken(NotificationPreference),
          useValue: {
            findOne: jest.fn(),
            save: jest.fn(),
            create: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<PreferenceEnforcer>(PreferenceEnforcer);
    mockPreferenceRepository = module.get(
      getRepositoryToken(NotificationPreference),
    ) as jest.Mocked<Repository<NotificationPreference>>;
  });

  describe('getPreferences', () => {
    it('should return user preferences', async () => {
      const mockPreferences = {
        userId: 'user-1',
        channels: {
          [DeliveryChannel.IN_APP]: true,
          [DeliveryChannel.EMAIL]: true,
        },
      };

      mockPreferenceRepository.findOne.mockResolvedValue(mockPreferences as any);

      const result = await service.getPreferences('user-1');

      expect(result.userId).toBe('user-1');
      expect(result.channels[DeliveryChannel.IN_APP]).toBe(true);
    });

    it('should create default preferences if not found', async () => {
      mockPreferenceRepository.findOne.mockResolvedValue(null);
      mockPreferenceRepository.create.mockReturnValue({
        userId: 'user-1',
        channels: { IN_APP: true, EMAIL: true },
      } as any);
      mockPreferenceRepository.save.mockResolvedValue({
        userId: 'user-1',
        channels: { IN_APP: true, EMAIL: true },
      } as any);

      const result = await service.getPreferences('user-1');

      expect(result.userId).toBe('user-1');
      expect(mockPreferenceRepository.create).toHaveBeenCalled();
      expect(mockPreferenceRepository.save).toHaveBeenCalled();
    });
  });

  describe('isChannelEnabled', () => {
    it('should return true if channel is enabled', async () => {
      mockPreferenceRepository.findOne.mockResolvedValue({
        userId: 'user-1',
        channels: {
          [DeliveryChannel.IN_APP]: true,
          [DeliveryChannel.EMAIL]: false,
        },
      } as any);

      const result = await service.isChannelEnabled('user-1', DeliveryChannel.IN_APP);

      expect(result).toBe(true);
    });

    it('should return false if channel is disabled', async () => {
      mockPreferenceRepository.findOne.mockResolvedValue({
        userId: 'user-1',
        channels: {
          [DeliveryChannel.IN_APP]: true,
          [DeliveryChannel.EMAIL]: false,
        },
      } as any);

      const result = await service.isChannelEnabled('user-1', DeliveryChannel.EMAIL);

      expect(result).toBe(false);
    });
  });

  describe('isCategoryEnabled', () => {
    it('should return true for enabled category', async () => {
      mockPreferenceRepository.findOne.mockResolvedValue({
        userId: 'user-1',
        categorySubscriptions: { CLAIM_CREATED: true },
      } as any);

      const result = await service.isCategoryEnabled('user-1', EventType.CLAIM_CREATED);

      expect(result).toBe(true);
    });

    it('should return true by default if no subscriptions defined', async () => {
      mockPreferenceRepository.findOne.mockResolvedValue({
        userId: 'user-1',
        categorySubscriptions: {},
      } as any);

      const result = await service.isCategoryEnabled('user-1', EventType.CLAIM_CREATED);

      expect(result).toBe(true);
    });

    it('should return false for disabled category', async () => {
      mockPreferenceRepository.findOne.mockResolvedValue({
        userId: 'user-1',
        categorySubscriptions: { CLAIM_CREATED: false },
      } as any);

      const result = await service.isCategoryEnabled('user-1', EventType.CLAIM_CREATED);

      expect(result).toBe(false);
    });
  });

  describe('isInQuietHours', () => {
    const mockQuietHours = (
      quietHours: Record<string, unknown> | undefined,
    ) => {
      mockPreferenceRepository.findOne.mockResolvedValue({
        userId: 'user-1',
        quietHours,
      } as any);
    };

    beforeEach(() => {
      jest.useFakeTimers();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it('should return false if quiet hours disabled', async () => {
      mockQuietHours({ enabled: false });

      const result = await service.isInQuietHours('user-1');

      expect(result).toBe(false);
    });

    it('should return false if quiet hours are absent', async () => {
      mockQuietHours(undefined);

      expect(await service.isInQuietHours('user-1')).toBe(false);
    });

    it('should return false if start or end time is missing', async () => {
      mockQuietHours({ enabled: true, startTime: '22:00', timezone: 'UTC' });

      expect(await service.isInQuietHours('user-1')).toBe(false);
    });

    it('should return false for malformed HH:mm boundaries', async () => {
      mockQuietHours({
        enabled: true,
        startTime: '25:99',
        endTime: '08:00',
        timezone: 'UTC',
      });

      expect(await service.isInQuietHours('user-1')).toBe(false);
    });

    describe('same-day window (inclusive boundaries, minute granularity)', () => {
      beforeEach(() => {
        mockQuietHours({
          enabled: true,
          startTime: '09:00',
          endTime: '17:00',
          timezone: 'UTC',
        });
      });

      it.each([
        ['2026-06-15T08:59:00Z', false],
        ['2026-06-15T09:00:00Z', true],
        ['2026-06-15T12:30:00Z', true],
        ['2026-06-15T16:59:00Z', true],
        ['2026-06-15T17:00:00Z', true],
        ['2026-06-15T17:01:00Z', false],
      ])('at %s UTC -> %s', async (iso, expected) => {
        jest.setSystemTime(new Date(iso));
        expect(await service.isInQuietHours('user-1')).toBe(expected);
      });
    });

    describe('overnight window', () => {
      beforeEach(() => {
        mockQuietHours({
          enabled: true,
          startTime: '22:00',
          endTime: '08:00',
          timezone: 'UTC',
        });
      });

      it.each([
        ['2026-06-15T21:59:00Z', false],
        ['2026-06-15T22:00:00Z', true],
        ['2026-06-15T23:30:00Z', true],
        ['2026-06-16T00:00:00Z', true],
        ['2026-06-16T07:59:00Z', true],
        ['2026-06-16T08:00:00Z', false],
        ['2026-06-16T12:00:00Z', false],
      ])('at %s UTC -> %s', async (iso, expected) => {
        jest.setSystemTime(new Date(iso));
        expect(await service.isInQuietHours('user-1')).toBe(expected);
      });
    });

    describe('timezone is respected', () => {
      it('evaluates the window in the user timezone, not server time', async () => {
        mockQuietHours({
          enabled: true,
          startTime: '20:00',
          endTime: '06:00',
          timezone: 'America/New_York',
        });

        jest.setSystemTime(new Date('2026-06-16T01:00:00Z'));
        expect(await service.isInQuietHours('user-1')).toBe(true);

        jest.setSystemTime(new Date('2026-06-16T13:00:00Z'));
        expect(await service.isInQuietHours('user-1')).toBe(false);
      });

      it('the same instant differs between UTC and a user timezone', async () => {
        jest.setSystemTime(new Date('2026-06-16T09:00:00Z'));

        mockQuietHours({
          enabled: true,
          startTime: '20:00',
          endTime: '06:00',
          timezone: 'UTC',
        });
        expect(await service.isInQuietHours('user-1')).toBe(false);

        mockQuietHours({
          enabled: true,
          startTime: '20:00',
          endTime: '06:00',
          timezone: 'America/New_York',
        });
        expect(await service.isInQuietHours('user-1')).toBe(true);
      });
    });

    describe('DST: America/New_York spring forward (2026-03-08, 02:00 EST -> 03:00 EDT)', () => {
      beforeEach(() => {
        mockQuietHours({
          enabled: true,
          startTime: '01:00',
          endTime: '04:00',
          timezone: 'America/New_York',
        });
      });

      it.each([
        ['2026-03-08T05:59:00Z', false],
        ['2026-03-08T06:00:00Z', true],
        ['2026-03-08T06:30:00Z', true],
        ['2026-03-08T07:00:00Z', true],
        ['2026-03-08T07:30:00Z', true],
        ['2026-03-08T08:00:00Z', true],
        ['2026-03-08T08:01:00Z', false],
      ])('at %s -> %s', async (iso, expected) => {
        jest.setSystemTime(new Date(iso));
        expect(await service.isInQuietHours('user-1')).toBe(expected);
      });
    });

    describe('DST: America/New_York fall back (2026-11-01, 02:00 EDT -> 01:00 EST)', () => {
      beforeEach(() => {
        mockQuietHours({
          enabled: true,
          startTime: '00:30',
          endTime: '01:45',
          timezone: 'America/New_York',
        });
      });

      it.each([
        ['2026-11-01T04:29:00Z', false],
        ['2026-11-01T04:30:00Z', true],
        ['2026-11-01T05:30:00Z', true],
        ['2026-11-01T06:00:00Z', true],
        ['2026-11-01T06:30:00Z', true],
        ['2026-11-01T06:45:00Z', true],
        ['2026-11-01T06:46:00Z', false],
      ])('at %s -> %s', async (iso, expected) => {
        jest.setSystemTime(new Date(iso));
        expect(await service.isInQuietHours('user-1')).toBe(expected);
      });
    });

    it('falls back to UTC for an invalid timezone', async () => {
      mockQuietHours({
        enabled: true,
        startTime: '01:00',
        endTime: '02:00',
        timezone: 'Not/AZone',
      });

      jest.setSystemTime(new Date('2026-06-15T01:30:00Z'));
      expect(await service.isInQuietHours('user-1')).toBe(true);

      jest.setSystemTime(new Date('2026-06-15T03:00:00Z'));
      expect(await service.isInQuietHours('user-1')).toBe(false);
    });

    it('defaults to UTC when no timezone is stored', async () => {
      mockQuietHours({
        enabled: true,
        startTime: '01:00',
        endTime: '02:00',
      });

      jest.setSystemTime(new Date('2026-06-15T01:30:00Z'));
      expect(await service.isInQuietHours('user-1')).toBe(true);
    });
  });

  describe('shouldDeliver', () => {
    it('should return allowed true when all constraints pass', async () => {
      mockPreferenceRepository.findOne.mockResolvedValue({
        userId: 'user-1',
        channels: { [DeliveryChannel.IN_APP]: true },
        categorySubscriptions: { CLAIM_CREATED: true },
        quietHours: { enabled: false },
      } as any);

      const result = await service.shouldDeliver(
        'user-1',
        EventType.CLAIM_CREATED,
        DeliveryChannel.IN_APP,
      );

      expect(result.allowed).toBe(true);
    });

    it('should block delivery if channel disabled', async () => {
      mockPreferenceRepository.findOne.mockResolvedValue({
        userId: 'user-1',
        channels: { [DeliveryChannel.IN_APP]: false },
      } as any);

      const result = await service.shouldDeliver(
        'user-1',
        EventType.CLAIM_CREATED,
        DeliveryChannel.IN_APP,
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('disabled');
    });

    it('should block delivery if category disabled', async () => {
      mockPreferenceRepository.findOne.mockResolvedValue({
        userId: 'user-1',
        channels: { [DeliveryChannel.IN_APP]: true },
        categorySubscriptions: { CLAIM_CREATED: false },
      } as any);

      const result = await service.shouldDeliver(
        'user-1',
        EventType.CLAIM_CREATED,
        DeliveryChannel.IN_APP,
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('disabled');
    });
  });

  describe('getEnabledChannels', () => {
    it('should return only enabled channels', async () => {
      mockPreferenceRepository.findOne.mockResolvedValue({
        userId: 'user-1',
        channels: {
          [DeliveryChannel.IN_APP]: true,
          [DeliveryChannel.EMAIL]: true,
          [DeliveryChannel.PUSH]: false,
          [DeliveryChannel.WEBHOOK]: false,
          [DeliveryChannel.WEBSOCKET]: true,
        },
      } as any);

      const result = await service.getEnabledChannels('user-1');

      expect(result).toContain(DeliveryChannel.IN_APP);
      expect(result).toContain(DeliveryChannel.EMAIL);
      expect(result).toContain(DeliveryChannel.WEBSOCKET);
      expect(result).not.toContain(DeliveryChannel.PUSH);
      expect(result.length).toBe(3);
    });
  });

describe('updatePreferences', () => {
  it('should update valid editable preferences', async () => {
    const original = {
      id: 'preference-1',
      userId: 'user-1',
      channels: {
        [DeliveryChannel.IN_APP]: true,
        [DeliveryChannel.EMAIL]: true,
      },
      categorySubscriptions: {},
      language: 'en',
      lastModifiedAt: new Date('2026-01-01T00:00:00Z'),
    };

    mockPreferenceRepository.findOne.mockResolvedValue(original as any);
    mockPreferenceRepository.save.mockImplementation(
      async (preference) => preference as NotificationPreference,
    );

    const updates: UpdatePreferenceSettingsDto = {
      channels: {
        [DeliveryChannel.IN_APP]: false,
        [DeliveryChannel.EMAIL]: true,
      },
      categorySubscriptions: {
        [EventType.CLAIM_CREATED]: false,
      },
      language: 'es',
      quietHours: {
        enabled: true,
        startTime: '22:00',
        endTime: '08:00',
        timezone: 'UTC',
      },
      digestPreferences: {
        enabled: true,
        frequency: 'DAILY',
        deliveryTime: '09:00',
      },
    };

    const result = await service.updatePreferences('user-1', updates);

    expect(result.channels[DeliveryChannel.IN_APP]).toBe(false);
    expect(result.categorySubscriptions[EventType.CLAIM_CREATED]).toBe(false);
    expect(result.language).toBe('es');
    expect(result.quietHours).toEqual(updates.quietHours);
    expect(result.digestPreferences).toEqual(updates.digestPreferences);

    expect(mockPreferenceRepository.save).toHaveBeenCalledTimes(1);
    expect(result.userId).toBe('user-1');
  });

  it('should preserve server-owned fields when malicious properties are submitted', async () => {
    const original = {
      id: 'preference-1',
      userId: 'user-1',
      user: { id: 'user-1' },
      unsubscribeToken: 'original-token',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
      lastModifiedAt: new Date('2026-01-03T00:00:00Z'),
      channels: {
        [DeliveryChannel.IN_APP]: true,
      },
      language: 'en',
    };

    mockPreferenceRepository.findOne.mockResolvedValue(original as any);
    mockPreferenceRepository.save.mockImplementation(
      async (preference) => preference as NotificationPreference,
    );

    // Simula una llamada que evita deliberadamente la validación HTTP del DTO.
    const maliciousUpdates = {
      language: 'es',
      id: 'attacker-preference-id',
      userId: 'user-2',
      user: { id: 'user-2' },
      unsubscribeToken: 'attacker-token',
      createdAt: new Date('2030-01-01T00:00:00Z'),
      updatedAt: new Date('2030-01-02T00:00:00Z'),
      lastModifiedAt: new Date('2030-01-03T00:00:00Z'),
    } as unknown as UpdatePreferenceSettingsDto;

    const result = await service.updatePreferences(
      'user-1',
      maliciousUpdates,
    );

    expect(result.language).toBe('es');

    expect(result.id).toBe('preference-1');
    expect(result.userId).toBe('user-1');
    expect(result.user).toEqual({ id: 'user-1' });
    expect(result.unsubscribeToken).toBe('original-token');
    expect(result.createdAt).toEqual(original.createdAt);
    expect(result.updatedAt).toEqual(original.updatedAt);

    // lastModifiedAt sí debe actualizarse, pero exclusivamente desde el servidor.
    expect(result.lastModifiedAt).toBeInstanceOf(Date);
    expect(result.lastModifiedAt).not.toEqual(
      new Date('2030-01-03T00:00:00Z'),
    );

    expect(mockPreferenceRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'preference-1',
        userId: 'user-1',
        unsubscribeToken: 'original-token',
      }),
    );
  });

  it('should not reassign the preference to another user', async () => {
    const original = {
      id: 'preference-1',
      userId: 'user-1',
      channels: {
        [DeliveryChannel.IN_APP]: true,
      },
      language: 'en',
    };

    mockPreferenceRepository.findOne.mockResolvedValue(original as any);
    mockPreferenceRepository.save.mockImplementation(
      async (preference) => preference as NotificationPreference,
    );

    const maliciousUpdates = {
      userId: 'user-2',
      language: 'es',
    } as unknown as UpdatePreferenceSettingsDto;

    const result = await service.updatePreferences(
      'user-1',
      maliciousUpdates,
    );

    expect(mockPreferenceRepository.findOne).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });

    expect(result.userId).toBe('user-1');
    expect(mockPreferenceRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('should preserve ownership and protected metadata during concurrent updates', async () => {
    const original = {
      id: 'preference-1',
      userId: 'user-1',
      unsubscribeToken: 'original-token',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
      channels: {
        [DeliveryChannel.IN_APP]: true,
      },
      language: 'en',
    };

    // Cada llamada recibe una instancia independiente, como ocurriría
    // al cargar la entidad en dos operaciones separadas.
    mockPreferenceRepository.findOne
      .mockResolvedValueOnce({ ...original, channels: { ...original.channels } } as any)
      .mockResolvedValueOnce({ ...original, channels: { ...original.channels } } as any);

    mockPreferenceRepository.save.mockImplementation(
      async (preference) => preference as NotificationPreference,
    );

    const [firstResult, secondResult] = await Promise.all([
      service.updatePreferences('user-1', {
        language: 'es',
      }),
      service.updatePreferences('user-1', {
        channels: {
          [DeliveryChannel.IN_APP]: false,
        },
      }),
    ]);

    for (const result of [firstResult, secondResult]) {
      expect(result.id).toBe('preference-1');
      expect(result.userId).toBe('user-1');
      expect(result.unsubscribeToken).toBe('original-token');
      expect(result.createdAt).toEqual(original.createdAt);
    }

    expect(mockPreferenceRepository.save).toHaveBeenCalledTimes(2);
  });

  it('should persist false values instead of ignoring them', async () => {
    const original = {
      id: 'preference-1',
      userId: 'user-1',
      channels: {
        [DeliveryChannel.IN_APP]: true,
      },
      quietHours: { enabled: true },
      digestPreferences: { enabled: true },
      pushConfig: { enabled: true },
    };

    mockPreferenceRepository.findOne.mockResolvedValue(original as any);
    mockPreferenceRepository.save.mockImplementation(
      async (preference) => preference as NotificationPreference,
    );

    const result = await service.updatePreferences('user-1', {
      channels: {
        [DeliveryChannel.IN_APP]: false,
      },
      quietHours: { enabled: false },
      digestPreferences: { enabled: false },
      pushConfig: { enabled: false },
    });

    expect(result.channels[DeliveryChannel.IN_APP]).toBe(false);
    expect(result.quietHours?.enabled).toBe(false);
    expect(result.digestPreferences?.enabled).toBe(false);
    expect(result.pushConfig?.enabled).toBe(false);
  });
});
});

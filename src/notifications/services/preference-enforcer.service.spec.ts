import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PreferenceEnforcer } from './preference-enforcer.service';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { DeliveryChannel } from '../interfaces/notification.types';
import { EventType } from '../enums/event-type.enum';
import { UpdatePreferenceSettingsDto } from '../dto/update-preference-settings.dto';

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

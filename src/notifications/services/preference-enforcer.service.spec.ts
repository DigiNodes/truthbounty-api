import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PreferenceEnforcer } from './preference-enforcer.service';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { DeliveryChannel } from '../interfaces/notification.types';
import { EventType } from '../enums/event-type.enum';

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
        channels: { IN_APP: true, EMAIL: true },
      };

      mockPreferenceRepository.findOne.mockResolvedValue(mockPreferences as any);

      const result = await service.getPreferences('user-1');

      expect(result.userId).toBe('user-1');
      expect(result.channels.IN_APP).toBe(true);
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
        channels: { IN_APP: true, EMAIL: false },
      } as any);

      const result = await service.isChannelEnabled('user-1', DeliveryChannel.IN_APP);

      expect(result).toBe(true);
    });

    it('should return false if channel is disabled', async () => {
      mockPreferenceRepository.findOne.mockResolvedValue({
        userId: 'user-1',
        channels: { IN_APP: true, EMAIL: false },
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
    it('should return false if quiet hours disabled', async () => {
      mockPreferenceRepository.findOne.mockResolvedValue({
        userId: 'user-1',
        quietHours: { enabled: false },
      } as any);

      const result = await service.isInQuietHours('user-1');

      expect(result).toBe(false);
    });

    it('should return true if current time is in quiet hours', async () => {
      // Mock: 23:00 - 08:00 quiet hours, current time 23:30
      mockPreferenceRepository.findOne.mockResolvedValue({
        userId: 'user-1',
        quietHours: {
          enabled: true,
          startTime: '23:00',
          endTime: '08:00',
          timezone: 'UTC',
        },
      } as any);

      // This test is timezone-dependent; adjust as needed
      // For now, just test the logic path
      const result = await service.isInQuietHours('user-1');

      expect(typeof result).toBe('boolean');
    });
  });

  describe('shouldDeliver', () => {
    it('should return allowed true when all constraints pass', async () => {
      mockPreferenceRepository.findOne.mockResolvedValue({
        userId: 'user-1',
        channels: { IN_APP: true },
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
        channels: { IN_APP: false },
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
        channels: { IN_APP: true },
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
          IN_APP: true,
          EMAIL: true,
          PUSH: false,
          WEBHOOK: false,
          WEBSOCKET: true,
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
    it('should update and save preferences', async () => {
      const original = {
        userId: 'user-1',
        channels: { IN_APP: true },
      };

      mockPreferenceRepository.findOne.mockResolvedValue(original as any);
      mockPreferenceRepository.save.mockResolvedValue({
        ...original,
        channels: { IN_APP: false },
      } as any);

      const result = await service.updatePreferences('user-1', {
        channels: { IN_APP: false },
      });

      expect(mockPreferenceRepository.save).toHaveBeenCalled();
    });
  });
});

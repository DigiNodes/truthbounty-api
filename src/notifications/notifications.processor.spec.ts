import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsProcessor } from './notifications.processor';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Notification } from './entities/notification.entity';
import { NotificationPreference } from './entities/notification-preference.entity';
import { NotificationStatus } from './enums/notification-status.enum';

describe('NotificationsProcessor', () => {
  let processor: NotificationsProcessor;
  let mockNotificationRepository: any;
  let mockPreferenceRepository: any;

  beforeEach(async () => {
    mockNotificationRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
    };

    mockPreferenceRepository = {
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((dto) => dto),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsProcessor,
        {
          provide: getRepositoryToken(Notification),
          useValue: mockNotificationRepository,
        },
        {
          provide: getRepositoryToken(NotificationPreference),
          useValue: mockPreferenceRepository,
        },
      ],
    }).compile();

    processor = module.get<NotificationsProcessor>(NotificationsProcessor);
  });

  it('should process a notification and mark as DELIVERED', async () => {
    const notification = { id: '1', userId: 'user-1', status: NotificationStatus.QUEUED, category: 'SYSTEM' };
    mockNotificationRepository.findOne.mockResolvedValue(notification);
    mockPreferenceRepository.findOne.mockResolvedValue({ userId: 'user-1', enabledChannels: ['IN_APP'] });

    const job = { data: { notificationId: '1' }, attemptsMade: 0, opts: { attempts: 3 } } as any;
    
    await processor.process(job);

    expect(notification.status).toBe(NotificationStatus.DELIVERED);
    expect(mockNotificationRepository.save).toHaveBeenCalledWith(notification);
  });

  it('should skip notification if category is disabled', async () => {
    const notification = { id: '1', userId: 'user-1', status: NotificationStatus.QUEUED, category: 'SYSTEM' };
    mockNotificationRepository.findOne.mockResolvedValue(notification);
    mockPreferenceRepository.findOne.mockResolvedValue({ userId: 'user-1', disabledCategories: ['SYSTEM'] });

    const job = { data: { notificationId: '1' } } as any;
    
    await processor.process(job);

    expect(notification.status).toBe(NotificationStatus.DISMISSED);
    expect(mockNotificationRepository.save).toHaveBeenCalledWith(notification);
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Notification } from './entities/notification.entity';
import { NotificationPreference } from './entities/notification-preference.entity';
import { NotificationStatus } from './enums/notification-status.enum';
import { NotificationCategory } from './enums/notification-category.enum';
import { NotificationChannel } from './enums/notification-channel.enum';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let mockNotificationRepository: any;
  let mockPreferenceRepository: any;
  let mockQueue: any;

  beforeEach(async () => {
    mockNotificationRepository = {
      create: jest.fn().mockImplementation((dto) => dto),
      save: jest.fn().mockImplementation((entity) => Promise.resolve({ id: '1', ...entity })),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      count: jest.fn(),
    };

    mockPreferenceRepository = {
      create: jest.fn().mockImplementation((dto) => dto),
      save: jest.fn().mockImplementation((entity) => Promise.resolve({ id: '1', ...entity })),
      findOne: jest.fn(),
    };

    mockQueue = {
      add: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: getRepositoryToken(Notification),
          useValue: mockNotificationRepository,
        },
        {
          provide: getRepositoryToken(NotificationPreference),
          useValue: mockPreferenceRepository,
        },
        {
          provide: getQueueToken('notifications'),
          useValue: mockQueue,
        },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  it('should queue a notification', async () => {
    const dto = {
      userId: 'user-1',
      category: NotificationCategory.CLAIM,
      title: 'New Claim',
      content: 'A claim has been made.',
    };

    const result = await service.queueNotification(dto);

    expect(result.userId).toEqual('user-1');
    expect(result.status).toEqual(NotificationStatus.QUEUED);
    expect(mockNotificationRepository.save).toHaveBeenCalled();
    expect(mockQueue.add).toHaveBeenCalledWith('send', { notificationId: '1' }, expect.any(Object));
  });

  it('should return default preferences if not found', async () => {
    mockPreferenceRepository.findOne.mockResolvedValue(null);
    const result = await service.getUserPreferences('user-1');
    expect(result.userId).toEqual('user-1');
    expect(mockPreferenceRepository.save).toHaveBeenCalled();
  });
});

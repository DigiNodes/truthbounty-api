import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Notification } from './entities/notification.entity';
import { NotificationPreference } from './entities/notification-preference.entity';
import { NotificationStatus } from './enums/notification-status.enum';
import { NotificationCategory } from './enums/notification-category.enum';
import { LessThan, MoreThanOrEqual } from 'typeorm';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let mockNotificationRepository: any;
  let mockPreferenceRepository: any;
  let mockQueue: any;

  beforeEach(async () => {
    mockNotificationRepository = {
      create: jest.fn().mockImplementation((dto) => dto),
      save: jest
        .fn()
        .mockImplementation((entity) =>
          Promise.resolve({ id: '1', ...entity }),
      ),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
    };

    mockPreferenceRepository = {
      create: jest.fn().mockImplementation((dto) => dto),
      save: jest
        .fn()
        .mockImplementation((entity) =>
          Promise.resolve({ id: '1', ...entity }),
      ),
      findOne: jest.fn(),
    };

    mockQueue = {
      add: jest.fn().mockResolved(true),
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
    expect(mockQueue.add).toHaveBeenCalledWith(
      'send',
      { notificationId: '1' },
      expect.any(Object),
    );
  });

  it('should return default preferences if not found', async () => {
    mockPreferenceRepository.findOne.mockResolvedValue(null);
    const result = await service.getUserPreferences('user-1');
    expect(result.userId).toEqual('user-1');
    expect(mockPreferenceRepository.save).toHaveBeenCalled();
  });

  it('should filter history by date range using TypeORM operators', async () => {
    mockNotificationRepository.findAndCount.mockResolvedValue([[], 0]);
    const from = new Date('2024-01-01T00:00:00.000Z');
    const to = new Date('2024-01-31T23:59:59.999Z');

    await service.getDeliveryHistory('user-1', { from, to });

    const [opts] = mockNotificationRepository.findAndCount.mock.calls[0];
    expect(opts.where.userId).toEqual('user-1');
    expect(opts.where.createdAt).toBeInstanceOf(MoreThanOrEqual);
    expect(opts.where.createdAt.value).toEqual(from);
  });

  it('should paginate delivery history', async () => {
    mockNotificationRepository.findAndCount.mockResolvedValue([[], 0]);

    await service.getDeliveryHistory('user-1', { page: 2, limit: 25 });

    const [opts] = mockNotificationRepository.findAndCount.mock.calls[0];
    expect(opts.skip).toEqual(25);
    expect(opts.take).toEqual(25);
  });

  it('should enforce user isolation in delivery history', async () => {
    mockNotificationRepository.findAndCount.mockResolvedValue([[], 0]);

    await service.getDeliveryHistory('user-2', {});

    const [opts] = mockNotificationRepository.findAndCount.mock.calls[0];
    expect(opts.where.userId).toEqual('user-2');
  });

  it('should remove retained records fail-closed on missing cutoff', async () => {
    await expect(service.retainOlderThan(undefined as unknown as Date)).rejects.toThrow();
    expect(mockNotificationRepository.delete).not.toHaveBeenCalled();
  });

  it('should retain records using TypeORM lessThan operator', async () => {
    mockNotificationRepository.delete.mockResolvedValue({ affected: 3 });
    const cutoff = new Date('2024-01-01T00:00:00.000Z');

    const result = await service.retainOlderThan(cutoff);

    expect(result).toEqual(3);
    const [criteria] = mockNotificationRepository.delete.mock.calls[0];
    expect(criteria.createdAt).toBeInstanceOf(LessThan);
    expect(criteria.createdAt.value).toEqual(cutoff);
  });

  it('should handle concurrent queuing without crossing user boundaries', async () => {
    const results = await Promise.all([
      service.queueNotification({
        userId: 'user-1',
        category: NotificationCategory.CLAIM,
        title: 'A',
        content: 'A',
      }),
      service.queueNotification({
        userId: 'user-2',
        category: NotificationCategory.CLAIM,
        title: 'B',
        content: 'B',
      }),
    ]);

    expect(results.map((r) => r.userId)).toEqual(['user-1', 'user-2']);
    expect(mockQueue.add).toHaveBeenCalledTimes(2);
  });
})

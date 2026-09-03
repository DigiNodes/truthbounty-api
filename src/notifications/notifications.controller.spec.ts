import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationCategory } from './enums/notification-category.enum';

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let mockService: any;

  beforeEach(async () => {
    mockService = {
      queueNotification: jest.fn().mockResolvedValue({ id: '1' }),
      getUserPreferences: jest.fn().mockResolvedValue({ userId: 'user-1' }),
      updateUserPreferences: jest.fn().mockResolvedValue({ userId: 'user-1' }),
      getDeliveryHistory: jest.fn().mockResolvedValue([[], 0]),
      getMetrics: jest.fn().mockResolvedValue({ total: 0 }),
      markAsRead: jest.fn().mockResolvedValue({ id: '1' }),
      dismiss: jest.fn().mockResolvedValue({ id: '1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        {
          provide: NotificationsService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<NotificationsController>(NotificationsController);
  });

  it('should call queueNotification', async () => {
    await controller.queueEvent({
      userId: '1',
      category: NotificationCategory.CLAIM,
      title: 'Test',
      content: 'Test content',
    });
    expect(mockService.queueNotification).toHaveBeenCalled();
  });

  it('should call getPreferences', async () => {
    await controller.getPreferences({ user: { id: 'user-1' } });
    expect(mockService.getUserPreferences).toHaveBeenCalledWith('user-1');
  });
});

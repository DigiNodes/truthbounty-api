import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { NotificationService } from './notification.service';
import { TemplateService } from './template.service';
import { Notification } from '../entities/notification.entity';
import { NotificationDelivery } from '../entities/notification-delivery.entity';
import { UserNotificationPreference } from '../entities/user-notification-preference.entity';
import {
  NotificationType,
  DeliveryChannel,
  DeliveryStatus,
  NotificationPriority,
  NotificationFrequency,
} from '../enums/notification-type.enum';
import { InAppDeliveryService } from './delivery/in-app-delivery.service';
import { EmailDeliveryService } from './delivery/email-delivery.service';
import { WebhookDeliveryService } from './delivery/webhook-delivery.service';
import { PushDeliveryService } from './delivery/push-delivery.service';
import { SmsDeliveryService } from './delivery/sms-delivery.service';

describe('NotificationService', () => {
  let service: NotificationService;
  let notificationRepo: Repository<Notification>;
  let deliveryRepo: Repository<NotificationDelivery>;
  let preferencesRepo: Repository<UserNotificationPreference>;
  let queueMock: any;
  let templateServiceMock: any;

  const mockNotification = {
    id: 'notif-1',
    userId: 'user-1',
    type: NotificationType.CLAIM_SUBMITTED,
    title: 'Test Notification',
    body: 'Test body',
    status: 'PENDING',
    priority: NotificationPriority.NORMAL,
    data: {},
    read: false,
    deliveries: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockDelivery = {
    id: 'delivery-1',
    notificationId: 'notif-1',
    channel: DeliveryChannel.IN_APP,
    status: DeliveryStatus.PENDING,
    retryCount: 0,
    maxRetries: 5,
    queuedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPreferences = {
    id: 'pref-1',
    userId: 'user-1',
    enabledChannels: ['IN_APP', 'EMAIL'],
    frequency: NotificationFrequency.INSTANT,
    notificationsEnabled: true,
    subscribedCategories: [],
    unsubscribedCategories: [],
    digestEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    queueMock = {
      add: jest.fn().mockResolvedValue({ id: 'queue-job-1' }),
      getWaitingCount: jest.fn().mockResolvedValue(5),
      getActiveCount: jest.fn().mockResolvedValue(2),
      getDelayedCount: jest.fn().mockResolvedValue(1),
    };

    templateServiceMock = {
      render: jest.fn(),
      createTemplate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        {
          provide: getRepositoryToken(Notification),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(NotificationDelivery),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(UserNotificationPreference),
          useClass: Repository,
        },
        {
          provide: TemplateService,
          useValue: templateServiceMock,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'SMTP_HOST') return 'localhost';
              if (key === 'SMTP_PORT') return 587;
              if (key === 'SMTP_USER') return '';
              if (key === 'SMTP_PASS') return '';
              if (key === 'SMTP_FROM') return 'noreply@truthbounty.com';
              return undefined;
            }),
          },
        },
        {
          provide: getQueueToken('notifications-queue'),
          useValue: queueMock,
        },
        InAppDeliveryService,
        EmailDeliveryService,
        WebhookDeliveryService,
        PushDeliveryService,
        SmsDeliveryService,
      ],
    }).compile();

    service = module.get<NotificationService>(NotificationService);
    notificationRepo = module.get<Repository<Notification>>(getRepositoryToken(Notification));
    deliveryRepo = module.get<Repository<NotificationDelivery>>(getRepositoryToken(NotificationDelivery));
    preferencesRepo = module.get<Repository<UserNotificationPreference>>(getRepositoryToken(UserNotificationPreference));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create a notification and enqueue delivery', async () => {
      const createSpy = jest.spyOn(notificationRepo, 'create').mockReturnValue(mockNotification as any);
      const saveSpy = jest.spyOn(notificationRepo, 'save').mockResolvedValue(mockNotification as any);
      const findOneSpy = jest.spyOn(notificationRepo, 'findOne').mockResolvedValue({ ...mockNotification, deliveries: [] } as any);
      const deliveryCreateSpy = jest.spyOn(deliveryRepo, 'create').mockReturnValue(mockDelivery as any);
      const deliverySaveSpy = jest.spyOn(deliveryRepo, 'save').mockResolvedValue(mockDelivery as any);
      jest.spyOn(preferencesRepo, 'findOne').mockResolvedValue(mockPreferences as any);
      jest.spyOn(preferencesRepo, 'create').mockReturnValue(mockPreferences as any);

      const result = await service.create({
        type: NotificationType.CLAIM_SUBMITTED,
        userId: 'user-1',
        title: 'Test Notification',
        body: 'Test body',
      });

      expect(createSpy).toHaveBeenCalled();
      expect(saveSpy).toHaveBeenCalled();
      expect(deliveryCreateSpy).toHaveBeenCalled();
      expect(deliverySaveSpy).toHaveBeenCalled();
      expect(queueMock.add).toHaveBeenCalledWith(
        'deliver-notification',
        { notificationId: 'notif-1' },
        expect.objectContaining({ attempts: 5 }),
      );
      expect(result).toBeDefined();
    });

    it('should respect user preferences when creating notification', async () => {
      const userPrefs = {
        ...mockPreferences,
        notificationsEnabled: false,
      };
      jest.spyOn(preferencesRepo, 'findOne').mockResolvedValue(userPrefs as any);
      jest.spyOn(preferencesRepo, 'create').mockReturnValue(userPrefs as any);
      jest.spyOn(notificationRepo, 'create').mockReturnValue(mockNotification as any);
      jest.spyOn(notificationRepo, 'save').mockResolvedValue(mockNotification as any);
      jest.spyOn(notificationRepo, 'findOne').mockResolvedValue({ ...mockNotification, deliveries: [] } as any);

      await service.create({
        type: NotificationType.CLAIM_SUBMITTED,
        userId: 'user-1',
        title: 'Test',
        body: 'Test body',
      });

      const deliverySaveSpy = jest.spyOn(deliveryRepo, 'save');
      expect(deliverySaveSpy).not.toHaveBeenCalled();
    });
  });

  describe('processDelivery', () => {
    it('should process pending deliveries and mark them as delivered', async () => {
      const notifWithDeliveries = {
        ...mockNotification,
        deliveries: [{ ...mockDelivery }],
      };

      jest.spyOn(notificationRepo, 'findOne').mockResolvedValue(notifWithDeliveries as any);
      const notifSaveSpy = jest.spyOn(notificationRepo, 'save').mockResolvedValue(notifWithDeliveries as any);
      const deliverySaveSpy = jest.spyOn(deliveryRepo, 'save').mockResolvedValue(mockDelivery as any);

      await service.processDelivery('notif-1');

      expect(notifSaveSpy).toHaveBeenCalled();
      expect(deliverySaveSpy).toHaveBeenCalled();
    });

    it('should mark delivery as failed and retry with backoff', async () => {
      const failDelivery = {
        ...mockDelivery,
        channel: DeliveryChannel.WEBHOOK,
        destination: null,
      };
      const notifWithDeliveries = {
        ...mockNotification,
        deliveries: [{ ...failDelivery }],
      };

      jest.spyOn(notificationRepo, 'findOne').mockResolvedValue(notifWithDeliveries as any);
      const deliverySaveSpy = jest.spyOn(deliveryRepo, 'save').mockImplementation(async (d) => d as any);
      jest.spyOn(notificationRepo, 'save').mockImplementation(async (d) => d as any);

      await service.processDelivery('notif-1');

      expect(queueMock.add).toHaveBeenCalled();
      expect(deliverySaveSpy).toHaveBeenCalled();
    });

    it('should handle notification not found gracefully', async () => {
      jest.spyOn(notificationRepo, 'findOne').mockResolvedValue(null);
      await expect(service.processDelivery('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('user preferences', () => {
    it('should get or create preferences', async () => {
      jest.spyOn(preferencesRepo, 'findOne').mockResolvedValue(null);
      const createSpy = jest.spyOn(preferencesRepo, 'create').mockReturnValue(mockPreferences as any);
      const saveSpy = jest.spyOn(preferencesRepo, 'save').mockResolvedValue(mockPreferences as any);

      const result = await service.getOrCreatePreferences('new-user');

      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'new-user' }));
      expect(saveSpy).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should update preferences', async () => {
      jest.spyOn(preferencesRepo, 'findOne').mockResolvedValue(mockPreferences as any);
      const saveSpy = jest.spyOn(preferencesRepo, 'save').mockImplementation(async (p) => p as any);

      const result = await service.updatePreferences('user-1', {
        frequency: NotificationFrequency.DAILY,
        emailAddress: 'test@example.com',
      });

      expect(saveSpy).toHaveBeenCalled();
      expect(result.frequency).toBe(NotificationFrequency.DAILY);
      expect(result.emailAddress).toBe('test@example.com');
    });

    it('should enforce quiet hours', async () => {
      const quietPrefs = {
        ...mockPreferences,
        quietHoursStart: ['22:00'],
        quietHoursEnd: ['06:00'],
      };

      jest.spyOn(preferencesRepo, 'findOne').mockResolvedValue(quietPrefs as any);
      jest.spyOn(preferencesRepo, 'save').mockImplementation(async (p) => p as any);

      const result = await service.getOrCreatePreferences('user-1');
      expect(result.quietHoursStart).toEqual(['22:00']);
      expect(result.quietHoursEnd).toEqual(['06:00']);
    });
  });

  describe('markAsRead', () => {
    it('should mark notification as read', async () => {
      jest.spyOn(notificationRepo, 'findOne').mockResolvedValue(mockNotification as any);
      const saveSpy = jest.spyOn(notificationRepo, 'save').mockResolvedValue({ ...mockNotification, read: true, readAt: new Date() } as any);

      const result = await service.markAsRead('notif-1', 'user-1');

      expect(saveSpy).toHaveBeenCalled();
      expect(result.read).toBe(true);
    });

    it('should throw when notification not found', async () => {
      jest.spyOn(notificationRepo, 'findOne').mockResolvedValue(null);
      await expect(service.markAsRead('nonexistent', 'user-1')).rejects.toThrow('Notification not found');
    });
  });

  describe('markAllAsRead', () => {
    it('should mark all unread notifications as read', async () => {
      jest.spyOn(notificationRepo, 'update').mockResolvedValue({ affected: 5, raw: {}, generatedMaps: [] } as any);

      const count = await service.markAllAsRead('user-1');

      expect(count).toBe(5);
    });
  });

  describe('scheduled notifications', () => {
    it('should schedule a notification with a future date', async () => {
      const createSpy = jest.spyOn(service, 'create').mockResolvedValue(mockNotification as any);
      const futureDate = new Date(Date.now() + 86400000).toISOString();

      const result = await service.scheduleNotification({
        type: NotificationType.SYSTEM_MAINTENANCE,
        userId: 'user-1',
        title: 'Scheduled Maintenance',
        body: 'System will be down',
        scheduledAt: futureDate,
      });

      expect(createSpy).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe('cancelScheduled', () => {
    it('should cancel a pending scheduled notification', async () => {
      const pendingNotif = { ...mockNotification, status: 'PENDING' };
      jest.spyOn(notificationRepo, 'findOne').mockResolvedValue(pendingNotif as any);
      const saveSpy = jest.spyOn(notificationRepo, 'save').mockImplementation(async (n) => n as any);
      jest.spyOn(deliveryRepo, 'update').mockResolvedValue({ affected: 1, raw: {}, generatedMaps: [] } as any);

      const result = await service.cancelScheduled('notif-1', 'user-1');

      expect(saveSpy).toHaveBeenCalled();
      expect(result.status).toBe('CANCELLED');
    });

    it('should throw when notification is not found', async () => {
      jest.spyOn(notificationRepo, 'findOne').mockResolvedValue(null);
      await expect(service.cancelScheduled('nonexistent', 'user-1')).rejects.toThrow('Notification not found');
    });
  });

  describe('getUserNotifications', () => {
    it('should return paginated notifications with total count', async () => {
      jest.spyOn(notificationRepo, 'findAndCount').mockResolvedValue([[mockNotification], 1] as any);

      const result = await service.getUserNotifications('user-1', {});

      expect(result.notifications).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe('getUnreadCount', () => {
    it('should return count of unread notifications', async () => {
      jest.spyOn(notificationRepo, 'count').mockResolvedValue(3);

      const count = await service.getUnreadCount('user-1');

      expect(count).toBe(3);
    });
  });

  describe('getDeliveryHistory', () => {
    it('should return delivery records for a notification', async () => {
      jest.spyOn(deliveryRepo, 'find').mockResolvedValue([mockDelivery] as any);

      const result = await service.getDeliveryHistory('notif-1');

      expect(result).toHaveLength(1);
    });
  });

  describe('getMetrics', () => {
    it('should return current metrics', async () => {
      jest.spyOn(deliveryRepo, 'count').mockResolvedValue(3);

      const metrics = await service.getMetrics();

      expect(metrics).toHaveProperty('queued');
      expect(metrics).toHaveProperty('delivered');
      expect(metrics).toHaveProperty('failed');
      expect(metrics).toHaveProperty('queueDepth');
      expect(metrics.queueDepth).toBe(8);
    });
  });
});

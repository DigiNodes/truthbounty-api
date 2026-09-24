import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { NotificationProcessor } from './notification.processor';
import { NotificationService } from './services/notification.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { NotificationDelivery } from './entities/notification-delivery.entity';
import { UserNotificationPreference } from './entities/user-notification-preference.entity';
import { TemplateService } from './services/template.service';
import { InAppDeliveryService } from './services/delivery/in-app-delivery.service';
import { EmailDeliveryService } from './services/delivery/email-delivery.service';
import { WebhookDeliveryService } from './services/delivery/webhook-delivery.service';
import { PushDeliveryService } from './services/delivery/push-delivery.service';
import { SmsDeliveryService } from './services/delivery/sms-delivery.service';

describe('NotificationProcessor', () => {
  let processor: NotificationProcessor;
  let notificationService: NotificationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        NotificationProcessor,
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
          useValue: {
            render: jest.fn(),
            createTemplate: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(() => undefined),
          },
        },
        {
          provide: getQueueToken('notifications-queue'),
          useValue: {
            add: jest.fn(),
            getWaitingCount: jest.fn().mockResolvedValue(0),
            getActiveCount: jest.fn().mockResolvedValue(0),
            getDelayedCount: jest.fn().mockResolvedValue(0),
          },
        },
        InAppDeliveryService,
        EmailDeliveryService,
        WebhookDeliveryService,
        PushDeliveryService,
        SmsDeliveryService,
      ],
    }).compile();

    processor = module.get<NotificationProcessor>(NotificationProcessor);
    notificationService = module.get<NotificationService>(NotificationService);
  });

  it('should be defined', () => {
    expect(processor).toBeDefined();
  });

  describe('process', () => {
    it('should process deliver-notification job', async () => {
      const processDeliverySpy = jest.spyOn(notificationService, 'processDelivery').mockResolvedValue(undefined);

      const mockJob = {
        id: 'job-1',
        name: 'deliver-notification',
        data: { notificationId: 'notif-1' },
      } as Job;

      const result = await processor.process(mockJob);

      expect(processDeliverySpy).toHaveBeenCalledWith('notif-1');
      expect(result).toEqual({ success: true, notificationId: 'notif-1' });
    });

    it('should throw error for unknown job name', async () => {
      const mockJob = {
        id: 'job-2',
        name: 'unknown-job',
        data: {},
      } as Job;

      await expect(processor.process(mockJob)).rejects.toThrow('Unknown notification job name: unknown-job');
    });

    it('should handle multiple concurrent deliveries', async () => {
      const processDeliverySpy = jest.spyOn(notificationService, 'processDelivery').mockResolvedValue(undefined);

      const jobs = [
        { id: 'job-1', name: 'deliver-notification', data: { notificationId: 'notif-1' } },
        { id: 'job-2', name: 'deliver-notification', data: { notificationId: 'notif-2' } },
        { id: 'job-3', name: 'deliver-notification', data: { notificationId: 'notif-3' } },
      ] as Job[];

      const results = await Promise.all(jobs.map((j) => processor.process(j)));

      expect(processDeliverySpy).toHaveBeenCalledTimes(3);
      results.forEach((r) => {
        expect(r.success).toBe(true);
      });
    });
  });
});

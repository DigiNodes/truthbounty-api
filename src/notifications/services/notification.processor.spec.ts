import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationProcessor } from './notification.processor';
import { Notification } from '../entities/notification.entity';
import { WebSocketService } from './websocket.service';
import { EmailService } from './email.service';
import { WebhookService } from './webhook.service';
import { DeliveryHistoryService } from './delivery-history.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { RedisService } from '../../redis/redis.service';
import {
  DeliveryChannel,
  DeliveryStatus,
} from '../interfaces/notification.types';
import { buildDeliveryIdempotencyKey } from '../delivery/delivery-idempotency-key';

describe('NotificationProcessor', () => {
  let processor: NotificationProcessor;
  let redisService: Partial<RedisService>;
  let deliveryHistoryService: Partial<DeliveryHistoryService>;
  let notificationRepository: any;
  let emailService: { sendNotificationEmail: jest.Mock };

  const mockNotification = {
    id: 'notif-uuid-1',
    userId: 'user-123',
    title: 'Test Notification',
    message: 'Test message',
    createdAt: new Date(),
  };

  const mockDeliveryRecord = {
    id: 'history-uuid-1',
    notificationId: 'notif-uuid-1',
    channel: DeliveryChannel.IN_APP,
    status: DeliveryStatus.PROCESSING,
    retryAttempts: 0,
  };

  const key = buildDeliveryIdempotencyKey({
    eventType: 'notification.send',
    recipientId: 'user-123',
    channel: DeliveryChannel.IN_APP,
    aggregateId: 'notif-uuid-1',
  });

  beforeEach(async () => {
    redisService = {
      setnx: jest.fn().mockResolvedValue(true),
      set: jest.fn().mockResolvedValue(true),
    };

    deliveryHistoryService = {
      acquireClaim: jest.fn().mockResolvedValue({
        acquired: true,
        idempotencyKey: key,
        claimId: 'claim-1',
        status: DeliveryStatus.PROCESSING,
        reason: 'acquired',
      }),
      findPendingDeliveryByNotificationAndChannel: jest
        .fn()
        .mockResolvedValue(mockDeliveryRecord),
      findByIdempotencyKey: jest.fn().mockResolvedValue(mockDeliveryRecord),
      createDeliveryRecord: jest.fn().mockResolvedValue(mockDeliveryRecord),
      updateDeliveryStatus: jest.fn().mockResolvedValue(mockDeliveryRecord),
      incrementRetryAttempts: jest.fn().mockResolvedValue(mockDeliveryRecord),
      confirmClaim: jest.fn().mockResolvedValue(mockDeliveryRecord),
      failClaim: jest.fn().mockResolvedValue(mockDeliveryRecord),
      markClaimUncertain: jest.fn().mockResolvedValue(mockDeliveryRecord),
    };

    notificationRepository = {
      findOne: jest.fn().mockResolvedValue(mockNotification),
    };
    emailService = {
      sendNotificationEmail: jest.fn().mockResolvedValue({
        success: true,
        status: DeliveryStatus.DELIVERED,
        deliveredAt: new Date(),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationProcessor,
        {
          provide: getRepositoryToken(Notification),
          useValue: notificationRepository,
        },
        {
          provide: WebSocketService,
          useValue: { broadcastNotification: jest.fn() },
        },
        { provide: EmailService, useValue: emailService },
        {
          provide: WebhookService,
          useValue: { getUserWebhooks: jest.fn().mockResolvedValue([]) },
        },
        { provide: DeliveryHistoryService, useValue: deliveryHistoryService },
        {
          provide: NotificationPreferencesService,
          useValue: {
            getUserPreferences: jest.fn().mockResolvedValue({
              emailAddress: 'verified@truthbounty.io',
            }),
          },
        },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    processor = module.get<NotificationProcessor>(NotificationProcessor);
  });

  const job = (attemptsMade = 0) =>
    ({
      data: {
        notificationId: 'notif-uuid-1',
        channel: DeliveryChannel.IN_APP,
        idempotencyKey: key,
      },
      attemptsMade,
    }) as any;

  it('acquires the durable claim before delivering', async () => {
    const result = await processor.process(job());

    expect(deliveryHistoryService.acquireClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: key,
        recipientId: 'user-123',
        channel: DeliveryChannel.IN_APP,
      }),
    );
    expect(deliveryHistoryService.confirmClaim).toHaveBeenCalledWith(
      key,
      'claim-1',
      expect.any(Object),
    );
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        status: DeliveryStatus.DELIVERED,
      }),
    );
  });

  it('does not treat a failed Redis SETNX as a failed or acquired claim', async () => {
    (redisService.setnx as jest.Mock).mockResolvedValueOnce(false);

    const result = await processor.process(job());

    expect(result.success).toBe(true);
    expect(result.deduplicated).toBeUndefined();
    expect(deliveryHistoryService.confirmClaim).toHaveBeenCalled();
  });

  it('suppresses a job when the durable claim reports DELIVERED', async () => {
    (deliveryHistoryService.acquireClaim as jest.Mock).mockResolvedValueOnce({
      acquired: false,
      idempotencyKey: key,
      status: DeliveryStatus.DELIVERED,
      reason: 'delivered',
    });

    const result = await processor.process(job(1));

    expect(result).toEqual({
      success: true,
      status: DeliveryStatus.DELIVERED,
      deduplicated: true,
    });
    expect(notificationRepository.findOne).toHaveBeenCalled();
    expect(emailService.sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('passes the delivery idempotency key to email providers', async () => {
    await processor.process({
      data: {
        notificationId: 'notif-uuid-1',
        channel: DeliveryChannel.EMAIL,
        idempotencyKey: key,
      },
      attemptsMade: 0,
    } as any);

    expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
      mockNotification,
      'user@example.com',
      key,
    );
  });

  it('retries the job when another worker holds the durable claim', async () => {
    (deliveryHistoryService.acquireClaim as jest.Mock).mockResolvedValueOnce({
      acquired: false,
      idempotencyKey: key,
      status: DeliveryStatus.PROCESSING,
      reason: 'in_progress',
    });

    await expect(processor.process(job())).rejects.toThrow(
      'Delivery claim not acquired (in_progress)',
    );
    expect(emailService.sendNotificationEmail).not.toHaveBeenCalled();
    expect(deliveryHistoryService.confirmClaim).not.toHaveBeenCalled();
  });

  it('keeps the claim processing when the provider outcome is uncertain', async () => {
    emailService.sendNotificationEmail.mockResolvedValueOnce({
      success: false,
      status: DeliveryStatus.FAILED,
      error: 'provider timeout',
    });

    await expect(
      processor.process({
        data: {
          notificationId: 'notif-uuid-1',
          channel: DeliveryChannel.EMAIL,
          idempotencyKey: key,
        },
        attemptsMade: 0,
      } as any),
    ).rejects.toThrow('provider timeout');

    expect(deliveryHistoryService.markClaimUncertain).toHaveBeenCalledWith(
      key,
      'claim-1',
      'provider timeout',
    );
    expect(deliveryHistoryService.failClaim).not.toHaveBeenCalled();
    expect(deliveryHistoryService.updateDeliveryStatus).not.toHaveBeenCalled();
  });
});

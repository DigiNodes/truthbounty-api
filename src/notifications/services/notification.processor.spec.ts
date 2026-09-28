import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationProcessor } from './notification.processor';
import { Notification } from '../entities/notification.entity';
import { WebSocketService } from './websocket.service';
import { EmailService } from './email.service';
import { WebhookService } from './webhook.service';
import { DeliveryHistoryService } from './delivery-history.service';
import { RedisService } from '../../redis/redis.service';
import { DeliveryChannel, DeliveryStatus } from '../interfaces/notification.types';

describe('NotificationProcessor', () => {
  let processor: NotificationProcessor;
  let redisService: Partial<RedisService>;
  let deliveryHistoryService: Partial<DeliveryHistoryService>;
  let notificationRepository: any;

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
    status: DeliveryStatus.PENDING,
    retryAttempts: 0,
  };

  beforeEach(async () => {
    redisService = {
      setnx: jest.fn().mockResolvedValue(true),
    };

    deliveryHistoryService = {
      findPendingDeliveryByNotificationAndChannel: jest.fn().mockResolvedValue(mockDeliveryRecord),
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      createDeliveryRecord: jest.fn().mockResolvedValue(mockDeliveryRecord),
      updateDeliveryStatus: jest.fn().mockResolvedValue(mockDeliveryRecord),
      incrementRetryAttempts: jest.fn().mockResolvedValue(mockDeliveryRecord),
    };

    notificationRepository = {
      findOne: jest.fn().mockResolvedValue(mockNotification),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationProcessor,
        { provide: getRepositoryToken(Notification), useValue: notificationRepository },
        { provide: WebSocketService, useValue: { broadcastNotification: jest.fn() } },
        { provide: EmailService, useValue: { sendNotificationEmail: jest.fn() } },
        { provide: WebhookService, useValue: { getUserWebhooks: jest.fn().mockResolvedValue([]) } },
        { provide: DeliveryHistoryService, useValue: deliveryHistoryService },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    processor = module.get<NotificationProcessor>(NotificationProcessor);
  });

  it('should process job and deliver via channel', async () => {
    const job = {
      data: {
        notificationId: 'notif-uuid-1',
        channel: DeliveryChannel.IN_APP,
        idempotencyKey: 'key-123',
      },
      attemptsMade: 0,
    } as any;

    const result = await processor.process(job);

    expect(redisService.setnx).toHaveBeenCalledWith('idempotency:notification:key-123', '1', 86400);
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        status: DeliveryStatus.DELIVERED,
      }),
    );
  });

  it('should suppress duplicate job execution when Redis SETNX returns false', async () => {
    (redisService.setnx as jest.Mock).mockResolvedValueOnce(false);

    const job = {
      data: {
        notificationId: 'notif-uuid-1',
        channel: DeliveryChannel.IN_APP,
        idempotencyKey: 'key-123',
      },
      attemptsMade: 0,
    } as any;

    const result = await processor.process(job);

    expect(result).toEqual({
      success: true,
      status: DeliveryStatus.DELIVERED,
      deduplicated: true,
    });
    expect(notificationRepository.findOne).not.toHaveBeenCalled();
  });

  it('should suppress duplicate job execution when DB check shows DELIVERED status', async () => {
    (deliveryHistoryService.findByIdempotencyKey as jest.Mock).mockResolvedValueOnce({
      status: DeliveryStatus.DELIVERED,
    });

    const job = {
      data: {
        notificationId: 'notif-uuid-1',
        channel: DeliveryChannel.IN_APP,
        idempotencyKey: 'key-123',
      },
      attemptsMade: 0,
    } as any;

    const result = await processor.process(job);

    expect(result).toEqual({
      success: true,
      status: DeliveryStatus.DELIVERED,
      deduplicated: true,
    });
    expect(notificationRepository.findOne).not.toHaveBeenCalled();
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { OutboxService } from '../src/outbox/outbox.service';
import { NotificationProcessor } from '../src/notifications/services/notification.processor';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { DeliveryHistoryService } from '../src/notifications/services/delivery-history.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Notification } from '../src/notifications/entities/notification.entity';
import { WebSocketService } from '../src/notifications/services/websocket.service';
import { EmailService } from '../src/notifications/services/email.service';
import { WebhookService } from '../src/notifications/services/webhook.service';
import { getQueueToken } from '@nestjs/bullmq';
import { DeliveryChannel, DeliveryStatus } from '../src/notifications/interfaces/notification.types';

// The real PrismaService pulls in the @libsql native driver adapter, which is not
// loadable on every developer machine/CI image. This flow is a deterministic
// service-level integration test (no database containers), so substitute a
// lightweight class reference for the DI token without loading the driver.
jest.mock('../src/prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

describe('Outbox & Idempotent Delivery Integration Flow', () => {
  let outboxService: OutboxService;
  let processor: NotificationProcessor;
  let mockQueue: any;
  let mockPrisma: any;
  let mockRedis: any;

  const mockOutboxEvents: any[] = [];
  const mockDeliveryRecords: any[] = [];

  beforeEach(async () => {
    mockOutboxEvents.length = 0;
    mockDeliveryRecords.length = 0;

    mockQueue = {
      add: jest.fn().mockImplementation((name, data, opts) => {
        return Promise.resolve({ id: opts.jobId || 'job-1' });
      }),
    };

    mockPrisma = {
      outboxEvent: {
        create: jest.fn().mockImplementation(({ data }) => {
          const record = { id: `outbox-${mockOutboxEvents.length + 1}`, ...data };
          mockOutboxEvents.push(record);
          return Promise.resolve(record);
        }),
        findMany: jest.fn().mockImplementation(() => Promise.resolve([...mockOutboxEvents])),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const idx = mockOutboxEvents.findIndex((e) => e.id === where.id);
          if (idx >= 0) {
            mockOutboxEvents[idx] = { ...mockOutboxEvents[idx], ...data };
          }
          return Promise.resolve(mockOutboxEvents[idx]);
        }),
        count: jest.fn().mockImplementation(() => Promise.resolve(mockOutboxEvents.length)),
      },
    };

    const redisLocks = new Set<string>();
    mockRedis = {
      setnx: jest.fn().mockImplementation((key: string) => {
        if (redisLocks.has(key)) return Promise.resolve(false);
        redisLocks.add(key);
        return Promise.resolve(true);
      }),
    };

    const mockDeliveryHistoryService = {
      findPendingDeliveryByNotificationAndChannel: jest.fn().mockResolvedValue(null),
      findByIdempotencyKey: jest.fn().mockImplementation((key: string) => {
        const found = mockDeliveryRecords.find((r) => r.idempotencyKey === key);
        return Promise.resolve(found || null);
      }),
      createDeliveryRecord: jest.fn().mockImplementation((notifId, channel, key) => {
        const rec = {
          id: `hist-${mockDeliveryRecords.length + 1}`,
          notificationId: notifId,
          channel,
          idempotencyKey: key,
          status: DeliveryStatus.DELIVERED,
        };
        mockDeliveryRecords.push(rec);
        return Promise.resolve(rec);
      }),
      updateDeliveryStatus: jest.fn().mockResolvedValue({}),
      incrementRetryAttempts: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        NotificationProcessor,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: getQueueToken('notifications'), useValue: mockQueue },
        { provide: MetricsService, useValue: { incrementCounter: jest.fn() } },
        { provide: RedisService, useValue: mockRedis },
        { provide: DeliveryHistoryService, useValue: mockDeliveryHistoryService },
        {
          provide: getRepositoryToken(Notification),
          useValue: {
            findOne: jest.fn().mockResolvedValue({
              id: 'notif-999',
              userId: 'user-888',
              title: 'Claim Verified',
              message: 'Your claim evaluation is ready.',
            }),
          },
        },
        { provide: WebSocketService, useValue: { broadcastNotification: jest.fn() } },
        { provide: EmailService, useValue: { sendNotificationEmail: jest.fn() } },
        { provide: WebhookService, useValue: { getUserWebhooks: jest.fn().mockResolvedValue([]) } },
      ],
    }).compile();

    outboxService = module.get<OutboxService>(OutboxService);
    processor = module.get<NotificationProcessor>(NotificationProcessor);
  });

  it('should complete the entire outbox -> queue -> processor flow exactly once', async () => {
    // 1. Transactional write of outbox event
    const eventId = await outboxService.publishEvent(mockPrisma as any, 'notification.send', 'notif-999', {
      channel: 'in_app',
      recipientIds: ['user-888'],
    });

    expect(eventId).toBeDefined();
    expect(mockOutboxEvents[0].status).toBe('PENDING');

    // Verify security requirement: payload does not contain PII or settlement details
    const payload = JSON.parse(mockOutboxEvents[0].payload);
    expect(payload).not.toHaveProperty('privateKey');
    expect(payload).not.toHaveProperty('settlementAmount');
    expect(payload.recipientIds).toEqual(['user-888']);

    // 2. Outbox poller claims and relays event to BullMQ
    await outboxService.processOutbox();
    expect(mockQueue.add).toHaveBeenCalledTimes(1);
    expect(mockOutboxEvents[0].status).toBe('DISPATCHED');

    // 3. Worker processes job first time
    const jobData = mockQueue.add.mock.calls[0][1];
    const firstResult = await processor.process({ data: jobData, attemptsMade: 0 } as any);
    expect(firstResult.status).toBe(DeliveryStatus.DELIVERED);
    expect(firstResult.deduplicated).toBeUndefined();

    // 4. Duplicate worker invocation (retry or duplicate message)
    const secondResult = await processor.process({ data: jobData, attemptsMade: 1 } as any);
    expect(secondResult.deduplicated).toBe(true);
    expect(secondResult.status).toBe(DeliveryStatus.DELIVERED);
  });
});

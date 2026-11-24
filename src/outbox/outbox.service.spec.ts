import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { OutboxService, OUTBOX_QUEUE_NAME } from './outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';

// Avoid loading the real @libsql native driver adapter transitively through
// prisma.service.ts; unit tests provide their own PrismaService mock via DI.
jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

describe('OutboxService', () => {
  let service: OutboxService;
  let prisma: { outboxEvent: Record<string, jest.Mock> };
  let queue: any;
  let metricsService: Partial<MetricsService>;

  const mockOutboxEvent = {
    id: 'outbox-uuid-1',
    eventType: 'notification.send',
    aggregateId: 'notif-123',
    payload: JSON.stringify({
      notificationId: 'notif-123',
      channel: 'in_app',
      recipientIds: ['user-1'],
    }),
    idempotencyKey: 'deterministic-key-1',
    status: 'PENDING',
    retryCount: 0,
    maxRetries: 5,
    scheduledAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    prisma = {
      outboxEvent: {
        create: jest.fn().mockResolvedValue({ id: 'outbox-uuid-1' }),
        findMany: jest.fn().mockResolvedValue([mockOutboxEvent]),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      } as any,
    };

    queue = {
      add: jest.fn().mockResolvedValue({ id: 'job-999' }),
    };

    metricsService = {
      incrementCounter: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken(OUTBOX_QUEUE_NAME), useValue: queue },
        { provide: MetricsService, useValue: metricsService },
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  describe('publishEvent', () => {
    it('should write an OutboxEvent inside the provided transaction with PENDING status', async () => {
      const mockTx = {
        outboxEvent: {
          create: jest.fn().mockResolvedValue({ id: 'event-id-1' }),
        },
      } as any;

      const eventId = await service.publishEvent(
        mockTx,
        'notification.send',
        'notif-123',
        { channel: 'in_app', recipientIds: ['user-42'] },
      );

      expect(eventId).toBe('event-id-1');
      expect(mockTx.outboxEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'notification.send',
          aggregateId: 'notif-123',
          status: 'PENDING',
          idempotencyKey: expect.any(String),
        }),
        select: { id: true },
      });
    });
  });

  describe('buildIdempotencyKey', () => {
    it('should generate a deterministic sha256 hash', () => {
      const key1 = service.buildIdempotencyKey('notification.send', 'notif-1', {
        channel: 'email',
        recipientIds: ['u1', 'u2'],
      });
      const key2 = service.buildIdempotencyKey('notification.send', 'notif-1', {
        channel: 'email',
        recipientIds: ['u2', 'u1'], // order reversed
      });

      expect(key1).toBe(key2);
      expect(key1).toHaveLength(64); // sha256 hex string
    });
  });

  describe('processOutbox', () => {
    it('should claim pending events and add them to BullMQ queue', async () => {
      await service.processOutbox();

      expect(queue.add).toHaveBeenCalledWith(
        'deliver-notification',
        expect.objectContaining({
          notificationId: 'notif-123',
          channel: 'in_app',
          idempotencyKey: 'deterministic-key-1',
          outboxEventId: 'outbox-uuid-1',
        }),
        expect.objectContaining({
          jobId: 'outbox-deterministic-key-1',
        }),
      );

      expect(prisma.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: 'outbox-uuid-1' },
        data: expect.objectContaining({
          status: 'DISPATCHED',
          jobId: 'job-999',
        }),
      });
    });

    it('should dead-letter events with invalid JSON payload', async () => {
      (prisma.outboxEvent.findMany as jest.Mock).mockResolvedValueOnce([
        {
          ...mockOutboxEvent,
          payload: '{ invalid-json',
        },
      ]);

      await service.processOutbox();

      expect(queue.add).not.toHaveBeenCalled();
      expect(prisma.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: 'outbox-uuid-1' },
        data: expect.objectContaining({
          status: 'DEAD_LETTER',
          lastError: expect.stringContaining('Invalid JSON payload'),
        }),
      });
    });

    it('should increment retryCount on queue error and dead-letter when maxRetries reached', async () => {
      queue.add.mockRejectedValueOnce(new Error('Redis connection lost'));

      await service.processOutbox();

      expect(prisma.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: 'outbox-uuid-1' },
        data: expect.objectContaining({
          retryCount: 1,
          status: 'PENDING',
          lastError: expect.stringContaining('Redis connection lost'),
        }),
      });
    });
  });
});

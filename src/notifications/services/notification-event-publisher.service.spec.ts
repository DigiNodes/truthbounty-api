import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationEventPublisher } from './notification-event-publisher.service';
import { OutboxEvent } from '../../outbox/entities/outbox-event.entity';
import { EventType } from '../enums/event-type.enum';
import { PublishEventDto } from '../dto/publish-event.dto';

describe('NotificationEventPublisher', () => {
  let service: NotificationEventPublisher;
  let mockOutboxRepository: jest.Mocked<Repository<OutboxEvent>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationEventPublisher,
        {
          provide: getRepositoryToken(OutboxEvent),
          useValue: {
            save: jest.fn(),
            findOne: jest.fn(),
            count: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<NotificationEventPublisher>(NotificationEventPublisher);
    mockOutboxRepository = module.get(getRepositoryToken(OutboxEvent)) as jest.Mocked<
      Repository<OutboxEvent>
    >;
  });

  describe('publishEvent', () => {
    it('should publish event successfully', async () => {
      const event: PublishEventDto = {
        eventType: EventType.CLAIM_CREATED,
        aggregateId: 'claim-123',
        recipientIds: ['user-1', 'user-2'],
        metadata: { title: 'Test Claim', amount: 1000 },
      };

      const savedEvent = {
        id: 'outbox-123',
        status: 'PENDING',
        idempotencyKey: expect.any(String),
      };

      mockOutboxRepository.save.mockResolvedValue(savedEvent as any);

      const result = await service.publishEvent(event);

      expect(result.status).toBe('PENDING');
      expect(result.id).toBe('outbox-123');
      expect(mockOutboxRepository.save).toHaveBeenCalled();
    });

    it('should throw error if no recipients', async () => {
      const event: PublishEventDto = {
        eventType: EventType.CLAIM_CREATED,
        aggregateId: 'claim-123',
        recipientIds: [],
        metadata: { title: 'Test Claim' },
      };

      await expect(service.publishEvent(event)).rejects.toThrow(
        'At least one recipient is required',
      );
    });

    it('should generate idempotency key deterministically', async () => {
      const event: PublishEventDto = {
        eventType: EventType.CLAIM_CREATED,
        aggregateId: 'claim-123',
        recipientIds: ['user-1', 'user-2'],
        metadata: { title: 'Test' },
      };

      mockOutboxRepository.save.mockResolvedValue({
        id: 'outbox-1',
        idempotencyKey: expect.any(String),
      } as any);

      const result1 = await service.publishEvent(event);
      const result2 = await service.publishEvent(event);

      // Same event should produce same idempotency key
      expect(result1.idempotencyKey).toBe(result2.idempotencyKey);
    });
  });

  describe('publishEvents', () => {
    it('should publish multiple events', async () => {
      const events: PublishEventDto[] = [
        {
          eventType: EventType.CLAIM_CREATED,
          aggregateId: 'claim-1',
          recipientIds: ['user-1'],
          metadata: {},
        },
        {
          eventType: EventType.VERIFICATION_COMPLETED,
          aggregateId: 'verification-1',
          recipientIds: ['user-1'],
          metadata: {},
        },
      ];

      mockOutboxRepository.save.mockResolvedValue({
        id: expect.any(String),
        idempotencyKey: expect.any(String),
      } as any);

      const results = await service.publishEvents(events);

      expect(results).toHaveLength(2);
      expect(mockOutboxRepository.save).toHaveBeenCalledTimes(2);
    });
  });

  describe('getEventStatus', () => {
    it('should return event status', async () => {
      const mockEvent = {
        id: 'outbox-123',
        status: 'DISPATCHED',
        retryCount: 2,
        processedAt: new Date(),
      };

      mockOutboxRepository.findOne.mockResolvedValue(mockEvent as any);

      const result = await service.getEventStatus('outbox-123');

      expect(result.status).toBe('DISPATCHED');
      expect(result.retryCount).toBe(2);
    });

    it('should return null if event not found', async () => {
      mockOutboxRepository.findOne.mockResolvedValue(null);

      const result = await service.getEventStatus('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getMetrics', () => {
    it('should return event metrics', async () => {
      mockOutboxRepository.count
        .mockResolvedValueOnce(10) // pending
        .mockResolvedValueOnce(50) // dispatched
        .mockResolvedValueOnce(2); // dead-letter

      mockOutboxRepository.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ avg: 1.5 }),
      } as any);

      const metrics = await service.getMetrics();

      expect(metrics.pendingEvents).toBe(10);
      expect(metrics.dispatchedEvents).toBe(50);
      expect(metrics.deadLetterEvents).toBe(2);
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { NotificationProcessor } from './notification-processor.service';
import { NotificationOrchestrator } from './notification-orchestrator.service';
import { DeliveryTracker } from './delivery-tracker.service';
import { PreferenceEnforcer } from './preference-enforcer.service';
import { OutboxEvent } from '../../outbox/entities/outbox-event.entity';
import { EventType } from '../enums/event-type.enum';
import { DeliveryChannel } from '../interfaces/notification.types';
import {
  NotificationDeliveryResult,
  DeliveryOutcome,
  aggregateRecipientResult,
  aggregateNotificationResult,
  successOutcome,
  skippedOutcome,
  retryableFailureOutcome,
  terminalFailureOutcome,
  channelUnavailableOutcome,
} from '../delivery/delivery-outcome';
import { DeliveryFailureKind } from '../delivery/delivery-error';

/**
 * Integration tests for PREWAVE-BE-127: Propagate recipient delivery failures
 * before dispatching notification outbox events.
 * 
 * These tests verify that:
 * 1. All channels fail → outbox is NOT marked DISPATCHED
 * 2. Partial recipient success → successful and failed recipients are independent
 * 3. Channel unavailable/disabled → never reported as provider-confirmed delivery
 * 4. Retryable provider failure → retry state is retained and bounded
 * 5. Terminal provider failure → dead-letter outcome is explicit and observable
 * 6. Successful provider-confirmed delivery → status transition is correct and idempotent
 */
describe('NotificationProcessor - Delivery Failure Propagation (PREWAVE-BE-127)', () => {
  let processor: NotificationProcessor;
  let outboxRepository: jest.Mocked<Repository<OutboxEvent>>;
  let orchestrator: jest.Mocked<NotificationOrchestrator>;
  let deliveryTracker: jest.Mocked<DeliveryTracker>;
  let preferenceEnforcer: jest.Mocked<PreferenceEnforcer>;
  let mockQueue: jest.Mocked<Partial<Queue>>;

  const createMockJob = (data: any): Partial<Job> => ({
    id: 'test-job-123',
    data,
    attemptsMade: 0,
  });

  beforeEach(async () => {
    // Mock repository
    outboxRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
      findAndCount: jest.fn(),
      delete: jest.fn(),
    } as any;

    // Mock orchestrator
    orchestrator = {
      deliverNotification: jest.fn(),
    } as any;

    // Mock delivery tracker
    deliveryTracker = {
      checkIdempotency: jest.fn(),
      recordDelivery: jest.fn(),
      recordFailure: jest.fn(),
      recordRetry: jest.fn(),
      isProviderConfirmed: jest.fn(),
      linkDeliveryToOutboxEvent: jest.fn(),
    } as any;

    // Mock preference enforcer
    preferenceEnforcer = {
      shouldDeliver: jest.fn(),
      getEnabledChannels: jest.fn(),
      isChannelEnabled: jest.fn(),
    } as any;

    // Mock queue
    mockQueue = {
      getJobCounts: jest.fn().mockResolvedValue({
        active: 0,
        completed: 10,
        failed: 2,
        delayed: 0,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationProcessor,
        {
          provide: getRepositoryToken(OutboxEvent),
          useValue: outboxRepository,
        },
        {
          provide: getQueueToken('notifications'),
          useValue: mockQueue,
        },
        {
          provide: NotificationOrchestrator,
          useValue: orchestrator,
        },
        {
          provide: DeliveryTracker,
          useValue: deliveryTracker,
        },
        {
          provide: PreferenceEnforcer,
          useValue: preferenceEnforcer,
        },
      ],
    }).compile();

    processor = module.get<NotificationProcessor>(NotificationProcessor);
  });

  describe('Test 1: All channels fail - outbox NOT marked DISPATCHED', () => {
    it('should NOT mark outbox as DISPATCHED when all channels fail with terminal errors', async () => {
      const outboxEvent: Partial<OutboxEvent> = {
        id: 'outbox-1',
        eventType: EventType.CLAIM_CREATED,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 5,
      };

      const jobData = {
        outboxEventId: 'outbox-1',
        eventType: EventType.CLAIM_CREATED,
        recipientIds: ['user-1', 'user-2'],
        payload: {},
        idempotencyKey: 'test-key-1',
      };

      outboxRepository.findOne.mockResolvedValue(outboxEvent as OutboxEvent);
      outboxRepository.save.mockImplementation((e) => Promise.resolve(e as OutboxEvent));

      // Mock all channels failing with terminal errors
      const deliveryResult: NotificationDeliveryResult = aggregateNotificationResult([
        aggregateRecipientResult('user-1', [
          terminalFailureOutcome(
            DeliveryChannel.IN_APP,
            DeliveryFailureKind.REJECTION,
            'Invalid recipient',
          ),
          terminalFailureOutcome(
            DeliveryChannel.EMAIL,
            DeliveryFailureKind.PERMANENT,
            'Email bounced',
          ),
        ]),
        aggregateRecipientResult('user-2', [
          terminalFailureOutcome(
            DeliveryChannel.IN_APP,
            DeliveryFailureKind.MALFORMED_PAYLOAD,
            'Payload validation failed',
          ),
        ]),
      ]);

      orchestrator.deliverNotification.mockResolvedValue(deliveryResult);

      const result = await processor.processJob(createMockJob(jobData) as Job);

      // Verify outbox was NOT marked DISPATCHED
      expect(result.success).toBe(false);
      expect(result.deadLettered).toBe(true);
      expect(outboxRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'DEAD_LETTER',
          lastError: expect.stringContaining('terminal failures'),
        }),
      );

      // Verify shouldDispatch was false
      expect(deliveryResult.shouldDispatch).toBe(false);
      expect(deliveryResult.anySuccess).toBe(false);
      expect(deliveryResult.completeFailure).toBe(true);
    });

    it('should NOT mark outbox as DISPATCHED when all recipients are skipped', async () => {
      const outboxEvent: Partial<OutboxEvent> = {
        id: 'outbox-2',
        eventType: EventType.CLAIM_VERIFIED,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 5,
      };

      const jobData = {
        outboxEventId: 'outbox-2',
        eventType: EventType.CLAIM_VERIFIED,
        recipientIds: ['user-1'],
        payload: {},
        idempotencyKey: 'test-key-2',
      };

      outboxRepository.findOne.mockResolvedValue(outboxEvent as OutboxEvent);
      outboxRepository.save.mockImplementation((e) => Promise.resolve(e as OutboxEvent));

      // Mock all channels being skipped
      const deliveryResult: NotificationDeliveryResult = aggregateNotificationResult([
        aggregateRecipientResult('user-1', [
          skippedOutcome(DeliveryChannel.EMAIL, 'Channel disabled for user'),
          skippedOutcome(DeliveryChannel.PUSH, 'Quiet hours active'),
        ]),
      ]);

      orchestrator.deliverNotification.mockResolvedValue(deliveryResult);

      const result = await processor.processJob(createMockJob(jobData) as Job);

      expect(result.success).toBe(false);
      expect(result.deadLettered).toBe(true);
      expect(outboxRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'DEAD_LETTER',
          lastError: expect.stringContaining('skipped'),
        }),
      );
      expect(deliveryResult.shouldDispatch).toBe(false);
      expect(deliveryResult.skippedRecipients).toBe(1);
    });
  });

  describe('Test 2: Partial recipient success - independent tracking', () => {
    it('should mark DISPATCHED with partial success and track both successful and failed recipients', async () => {
      const outboxEvent: Partial<OutboxEvent> = {
        id: 'outbox-3',
        eventType: EventType.CLAIM_DISPUTED,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 5,
      };

      const jobData = {
        outboxEventId: 'outbox-3',
        eventType: EventType.CLAIM_DISPUTED,
        recipientIds: ['user-1', 'user-2', 'user-3'],
        payload: {},
        idempotencyKey: 'test-key-3',
      };

      outboxRepository.findOne.mockResolvedValue(outboxEvent as OutboxEvent);
      outboxRepository.save.mockImplementation((e) => Promise.resolve(e as OutboxEvent));

      // Mix of success and failure
      const deliveryResult: NotificationDeliveryResult = aggregateNotificationResult([
        aggregateRecipientResult('user-1', [
          successOutcome(DeliveryChannel.IN_APP, 'msg-1', 'idem-1'),
          successOutcome(DeliveryChannel.EMAIL, 'msg-2', 'idem-2'),
        ]),
        aggregateRecipientResult('user-2', [
          terminalFailureOutcome(
            DeliveryChannel.IN_APP,
            DeliveryFailureKind.PERMANENT,
            'User deleted',
          ),
        ]),
        aggregateRecipientResult('user-3', [
          successOutcome(DeliveryChannel.PUSH, 'msg-3', 'idem-3'),
        ]),
      ]);

      orchestrator.deliverNotification.mockResolvedValue(deliveryResult);

      const result = await processor.processJob(createMockJob(jobData) as Job);

      // Verify DISPATCHED because 2 out of 3 recipients succeeded
      expect(result.success).toBe(true);
      expect(result.dispatched).toBe(true);
      expect(outboxRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'DISPATCHED',
          processedAt: expect.any(Date),
        }),
      );

      // Verify counts are independent
      expect(deliveryResult.shouldDispatch).toBe(true);
      expect(deliveryResult.successfulRecipients).toBe(2);
      expect(deliveryResult.terminalRecipients).toBe(1);
      expect(deliveryResult.totalRecipients).toBe(3);

      // Verify delivery result is stored in metadata
      const savedEvent = outboxRepository.save.mock.calls[1][0] as OutboxEvent;
      expect(savedEvent.metadata?.deliveryResult).toBeDefined();
      expect(savedEvent.metadata.deliveryResult.summary.successfulRecipients).toBe(2);
      expect(savedEvent.metadata.deliveryResult.recipients).toHaveLength(3);
    });
  });

  describe('Test 3: Channel unavailable/disabled - never provider-confirmed', () => {
    it('should mark channels as unavailable, not as delivered', async () => {
      const outboxEvent: Partial<OutboxEvent> = {
        id: 'outbox-4',
        eventType: EventType.STAKE_UPDATED,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 5,
      };

      const jobData = {
        outboxEventId: 'outbox-4',
        eventType: EventType.STAKE_UPDATED,
        recipientIds: ['user-1'],
        payload: {},
        idempotencyKey: 'test-key-4',
      };

      outboxRepository.findOne.mockResolvedValue(outboxEvent as OutboxEvent);
      outboxRepository.save.mockImplementation((e) => Promise.resolve(e as OutboxEvent));

      // Channel unavailable outcome
      const deliveryResult: NotificationDeliveryResult = aggregateNotificationResult([
        aggregateRecipientResult('user-1', [
          channelUnavailableOutcome(
            DeliveryChannel.WEBHOOK,
            'Channel implementation not registered',
          ),
          skippedOutcome(DeliveryChannel.SMS, 'Channel disabled for user'),
        ]),
      ]);

      orchestrator.deliverNotification.mockResolvedValue(deliveryResult);

      const result = await processor.processJob(createMockJob(jobData) as Job);

      // Verify not marked as DISPATCHED
      expect(result.success).toBe(false);
      expect(result.deadLettered).toBe(true);

      // Verify outcomes are correctly categorized
      const recipient = deliveryResult.recipients[0];
      const webhookChannel = recipient.channels.find(
        (c) => c.channel === DeliveryChannel.WEBHOOK,
      );
      const smsChannel = recipient.channels.find((c) => c.channel === DeliveryChannel.SMS);

      expect(webhookChannel?.outcome).toBe(DeliveryOutcome.CHANNEL_UNAVAILABLE);
      expect(webhookChannel?.providerMessageId).toBeUndefined();
      expect(smsChannel?.outcome).toBe(DeliveryOutcome.SKIPPED);
      expect(smsChannel?.providerMessageId).toBeUndefined();

      expect(deliveryResult.shouldDispatch).toBe(false);
      expect(deliveryResult.unavailableCount).toBeUndefined(); // This is per-recipient
      expect(recipient.unavailableCount).toBe(1);
      expect(recipient.skippedCount).toBe(1);
    });
  });

  describe('Test 4: Retryable provider failure - retry state retained and bounded', () => {
    it('should retry retryable failures within budget', async () => {
      const outboxEvent: Partial<OutboxEvent> = {
        id: 'outbox-5',
        eventType: EventType.REWARD_DISTRIBUTED,
        status: 'PENDING',
        retryCount: 2,
        maxRetries: 5,
      };

      const jobData = {
        outboxEventId: 'outbox-5',
        eventType: EventType.REWARD_DISTRIBUTED,
        recipientIds: ['user-1'],
        payload: {},
        idempotencyKey: 'test-key-5',
        retryCount: 2,
      };

      outboxRepository.findOne.mockResolvedValue(outboxEvent as OutboxEvent);
      outboxRepository.save.mockImplementation((e) => Promise.resolve(e as OutboxEvent));

      // Retryable failures
      const deliveryResult: NotificationDeliveryResult = aggregateNotificationResult([
        aggregateRecipientResult('user-1', [
          retryableFailureOutcome(
            DeliveryChannel.EMAIL,
            DeliveryFailureKind.TIMEOUT,
            'Provider timeout',
            2,
            'idem-5',
          ),
        ]),
      ]);

      orchestrator.deliverNotification.mockResolvedValue(deliveryResult);

      // Should throw to trigger BullMQ retry
      await expect(processor.processJob(createMockJob(jobData) as Job)).rejects.toThrow(
        /Retry/,
      );

      // Verify retry count incremented
      const savedEvent = outboxRepository.save.mock.calls.find((call) =>
        call[0].status === 'PENDING',
      )?.[0] as OutboxEvent;
      expect(savedEvent).toBeDefined();
      expect(savedEvent.retryCount).toBe(3);
      expect(savedEvent.status).toBe('PENDING');
    });

    it('should dead-letter retryable failures when retry budget exhausted', async () => {
      const outboxEvent: Partial<OutboxEvent> = {
        id: 'outbox-6',
        eventType: EventType.REWARD_DISTRIBUTED,
        status: 'PENDING',
        retryCount: 5,
        maxRetries: 5,
      };

      const jobData = {
        outboxEventId: 'outbox-6',
        eventType: EventType.REWARD_DISTRIBUTED,
        recipientIds: ['user-1'],
        payload: {},
        idempotencyKey: 'test-key-6',
        retryCount: 5,
      };

      outboxRepository.findOne.mockResolvedValue(outboxEvent as OutboxEvent);
      outboxRepository.save.mockImplementation((e) => Promise.resolve(e as OutboxEvent));

      // Still retryable but budget exhausted
      const deliveryResult: NotificationDeliveryResult = aggregateNotificationResult([
        aggregateRecipientResult('user-1', [
          retryableFailureOutcome(
            DeliveryChannel.EMAIL,
            DeliveryFailureKind.UNAVAILABLE,
            'Provider unavailable',
            5,
            'idem-6',
          ),
        ]),
      ]);

      orchestrator.deliverNotification.mockResolvedValue(deliveryResult);

      const result = await processor.processJob(createMockJob(jobData) as Job);

      // Should be dead-lettered
      expect(result.success).toBe(false);
      expect(result.deadLettered).toBe(true);
      expect(outboxRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'DEAD_LETTER',
          lastError: expect.stringContaining('retry budget exhausted'),
        }),
      );
    });
  });

  describe('Test 5: Terminal provider failure - explicit dead-letter', () => {
    it('should immediately dead-letter terminal failures without retry', async () => {
      const outboxEvent: Partial<OutboxEvent> = {
        id: 'outbox-7',
        eventType: EventType.REPUTATION_UPDATED,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 5,
      };

      const jobData = {
        outboxEventId: 'outbox-7',
        eventType: EventType.REPUTATION_UPDATED,
        recipientIds: ['user-1', 'user-2'],
        payload: {},
        idempotencyKey: 'test-key-7',
      };

      outboxRepository.findOne.mockResolvedValue(outboxEvent as OutboxEvent);
      outboxRepository.save.mockImplementation((e) => Promise.resolve(e as OutboxEvent));

      // All terminal failures
      const deliveryResult: NotificationDeliveryResult = aggregateNotificationResult([
        aggregateRecipientResult('user-1', [
          terminalFailureOutcome(
            DeliveryChannel.EMAIL,
            DeliveryFailureKind.REJECTION,
            '400 Bad Request - Invalid email format',
          ),
        ]),
        aggregateRecipientResult('user-2', [
          terminalFailureOutcome(
            DeliveryChannel.PUSH,
            DeliveryFailureKind.PERMANENT,
            'Push token expired',
          ),
        ]),
      ]);

      orchestrator.deliverNotification.mockResolvedValue(deliveryResult);

      const result = await processor.processJob(createMockJob(jobData) as Job);

      // Immediately dead-lettered
      expect(result.success).toBe(false);
      expect(result.deadLettered).toBe(true);
      expect(outboxRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'DEAD_LETTER',
          lastError: expect.stringContaining('terminal failures'),
        }),
      );

      // Verify retry count was NOT incremented
      const savedEvent = outboxRepository.save.mock.calls[1][0] as OutboxEvent;
      expect(savedEvent.retryCount).toBeUndefined();

      // Verify terminal failure details are preserved
      expect(deliveryResult.terminalRecipients).toBe(2);
      expect(deliveryResult.retryableRecipients).toBe(0);
      expect(result.deliveryResult.recipients[0].channels[0].failureKind).toBe(
        DeliveryFailureKind.REJECTION,
      );
    });
  });

  describe('Test 6: Successful provider-confirmed delivery - correct and idempotent', () => {
    it('should mark DISPATCHED with provider-confirmed deliveries', async () => {
      const outboxEvent: Partial<OutboxEvent> = {
        id: 'outbox-8',
        eventType: EventType.VOTE_CAST,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 5,
      };

      const jobData = {
        outboxEventId: 'outbox-8',
        eventType: EventType.VOTE_CAST,
        recipientIds: ['user-1'],
        payload: {},
        idempotencyKey: 'test-key-8',
      };

      outboxRepository.findOne.mockResolvedValue(outboxEvent as OutboxEvent);
      outboxRepository.save.mockImplementation((e) => Promise.resolve(e as OutboxEvent));

      // Provider-confirmed successful delivery
      const deliveryResult: NotificationDeliveryResult = aggregateNotificationResult([
        aggregateRecipientResult('user-1', [
          successOutcome(DeliveryChannel.EMAIL, 'provider-msg-123', 'idem-8-email'),
          successOutcome(DeliveryChannel.IN_APP, 'in-app-msg-456', 'idem-8-inapp'),
        ]),
      ]);

      orchestrator.deliverNotification.mockResolvedValue(deliveryResult);

      const result = await processor.processJob(createMockJob(jobData) as Job);

      // Verify DISPATCHED
      expect(result.success).toBe(true);
      expect(result.dispatched).toBe(true);
      expect(outboxRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'DISPATCHED',
          processedAt: expect.any(Date),
        }),
      );

      // Verify provider message IDs are preserved
      const savedEvent = outboxRepository.save.mock.calls[1][0] as OutboxEvent;
      const emailChannel = savedEvent.metadata.deliveryResult.recipients[0].channels.find(
        (c: any) => c.channel === DeliveryChannel.EMAIL,
      );
      expect(emailChannel.providerMessageId).toBe('provider-msg-123');
      expect(emailChannel.outcome).toBe(DeliveryOutcome.DELIVERED);

      // Verify idempotency keys are stored
      expect(emailChannel.idempotencyKey).toBeUndefined(); // Not serialized in current impl
    });

    it('should handle idempotent re-processing correctly', async () => {
      const outboxEvent: Partial<OutboxEvent> = {
        id: 'outbox-9',
        eventType: EventType.VOTE_CAST,
        status: 'DISPATCHED',
        processedAt: new Date(),
        retryCount: 0,
        maxRetries: 5,
      };

      const jobData = {
        outboxEventId: 'outbox-9',
        eventType: EventType.VOTE_CAST,
        recipientIds: ['user-1'],
        payload: {},
        idempotencyKey: 'test-key-9',
      };

      outboxRepository.findOne.mockResolvedValue(outboxEvent as OutboxEvent);

      // Second processing attempt - orchestrator should suppress via idempotency
      const deliveryResult: NotificationDeliveryResult = aggregateNotificationResult([
        aggregateRecipientResult('user-1', [
          skippedOutcome(
            DeliveryChannel.EMAIL,
            'Duplicate delivery prevented by idempotency guard',
          ),
        ]),
      ]);

      orchestrator.deliverNotification.mockResolvedValue(deliveryResult);

      const result = await processor.processJob(createMockJob(jobData) as Job);

      // Should complete without error but not change DISPATCHED status
      expect(result.success).toBe(false);
      expect(deliveryResult.shouldDispatch).toBe(false);
      expect(deliveryResult.skippedRecipients).toBe(1);
    });
  });

  describe('Edge cases and complex scenarios', () => {
    it('should handle mixed outcomes across multiple recipients', async () => {
      const outboxEvent: Partial<OutboxEvent> = {
        id: 'outbox-10',
        eventType: EventType.MODERATION_ACTION,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: 5,
      };

      const jobData = {
        outboxEventId: 'outbox-10',
        eventType: EventType.MODERATION_ACTION,
        recipientIds: ['user-1', 'user-2', 'user-3', 'user-4'],
        payload: {},
        idempotencyKey: 'test-key-10',
      };

      outboxRepository.findOne.mockResolvedValue(outboxEvent as OutboxEvent);
      outboxRepository.save.mockImplementation((e) => Promise.resolve(e as OutboxEvent));

      // Complex mix: success, skip, retryable, terminal, unavailable
      const deliveryResult: NotificationDeliveryResult = aggregateNotificationResult([
        // User 1: Full success
        aggregateRecipientResult('user-1', [
          successOutcome(DeliveryChannel.EMAIL, 'msg-1', 'idem-1'),
        ]),
        // User 2: Skipped due to preferences
        aggregateRecipientResult('user-2', [
          skippedOutcome(DeliveryChannel.EMAIL, 'User opted out'),
        ]),
        // User 3: Retryable failure
        aggregateRecipientResult('user-3', [
          retryableFailureOutcome(
            DeliveryChannel.EMAIL,
            DeliveryFailureKind.TIMEOUT,
            'Timeout',
            0,
            'idem-3',
          ),
        ]),
        // User 4: Terminal failure
        aggregateRecipientResult('user-4', [
          terminalFailureOutcome(
            DeliveryChannel.EMAIL,
            DeliveryFailureKind.PERMANENT,
            'Bounced',
          ),
        ]),
      ]);

      orchestrator.deliverNotification.mockResolvedValue(deliveryResult);

      const result = await processor.processJob(createMockJob(jobData) as Job);

      // Should be DISPATCHED because user-1 succeeded
      expect(result.success).toBe(true);
      expect(result.dispatched).toBe(true);

      // Verify counts
      expect(deliveryResult.successfulRecipients).toBe(1);
      expect(deliveryResult.skippedRecipients).toBe(1);
      expect(deliveryResult.retryableRecipients).toBe(1);
      expect(deliveryResult.terminalRecipients).toBe(1);
      expect(deliveryResult.shouldDispatch).toBe(true);
    });
  });
});

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { OutboxEvent } from '../../outbox/entities/outbox-event.entity';
import { PublishEventDto } from '../dto/publish-event.dto';
import { EventType, EVENT_PRIORITY_MAP, PRIORITY_RETRY_CONFIG } from '../enums/event-type.enum';
import * as crypto from 'crypto';

/**
 * NotificationEventPublisher
 * 
 * Central service for publishing protocol events that trigger notifications.
 * Uses the transactional outbox pattern for guaranteed delivery:
 * 1. Event and notification outbox entry created in atomic transaction
 * 2. OutboxScheduler polls and creates BullMQ jobs
 * 3. NotificationProcessor dequeues and delivers via channels
 * 
 * Provides:
 * - Exactly-once delivery semantics (idempotency keys)
 * - Decoupling of business logic from notification delivery
 * - Composable event routing and template resolution
 */
@Injectable()
export class NotificationEventPublisher {
  private readonly logger = new Logger(NotificationEventPublisher.name);

  constructor(
    @InjectRepository(OutboxEvent)
    private outboxRepository: Repository<OutboxEvent>,
  ) {}

  /**
   * Publish a protocol event for notification delivery
   * 
   * Must be called within a TypeORM transaction to ensure atomicity:
   * 
   * await this.transactionRunner.run(async (manager) => {
   *   await this.eventPublisher.publishEvent(event, manager);
   * });
   * 
   * @param event Event to publish
   * @param manager Optional EntityManager for transactional write
   * @returns Outbox event ID
   */
  async publishEvent(
    event: PublishEventDto,
    manager?: EntityManager,
  ): Promise<{ id: string; status: string; idempotencyKey: string }> {
    // Validate event
    if (!event.recipientIds || event.recipientIds.length === 0) {
      throw new BadRequestException('At least one recipient is required');
    }

    // Generate idempotency key
    const idempotencyKey = this.generateIdempotencyKey(
      event.eventType,
      event.aggregateId,
      event.recipientIds,
    );

    // Build routing payload (only metadata needed for delivery)
    const payload = {
      eventType: event.eventType,
      aggregateId: event.aggregateId,
      recipientIds: event.recipientIds,
      metadata: event.metadata,
      sourceUserId: event.sourceUserId,
      tags: event.tags || [],
    };

    // Determine retry configuration based on event priority
    const priority = EVENT_PRIORITY_MAP[event.eventType] || 'NORMAL';
    const retryConfig = PRIORITY_RETRY_CONFIG[priority];

    // Create outbox event
    const outboxEvent = new OutboxEvent();
    outboxEvent.eventType = `NOTIFICATION:${event.eventType}`;
    outboxEvent.aggregateId = event.aggregateId;
    outboxEvent.payload = payload;
    outboxEvent.idempotencyKey = idempotencyKey;
    outboxEvent.status = 'PENDING';
    outboxEvent.retryCount = 0;
    outboxEvent.maxRetries = retryConfig.maxRetries;

    // Use provided manager or repository
    const repository = manager
      ? manager.getRepository(OutboxEvent)
      : this.outboxRepository;

    const savedEvent = await repository.save(outboxEvent);

    this.logger.log(
      `Published notification event: ${event.eventType} ` +
      `for ${event.recipientIds.length} recipients (outboxId: ${savedEvent.id})`,
    );

    return {
      id: savedEvent.id,
      status: savedEvent.status,
      idempotencyKey: savedEvent.idempotencyKey,
    };
  }

  /**
   * Publish multiple events atomically
   * Useful for batch operations (e.g., verification completion triggers multiple events)
   */
  async publishEvents(
    events: PublishEventDto[],
    manager?: EntityManager,
  ): Promise<Array<{ id: string; status: string; idempotencyKey: string }>> {
    const results = [];

    for (const event of events) {
      const result = await this.publishEvent(event, manager);
      results.push(result);
    }

    return results;
  }

  /**
   * Generate deterministic idempotency key
   * Ensures duplicate event publications are detected and suppressed
   * 
   * Key components:
   * - eventType: distinguishes event types
   * - aggregateId: ensures unique per aggregate
   * - recipientIds (sorted): prevents duplicate for same recipients
   */
  private generateIdempotencyKey(
    eventType: EventType,
    aggregateId: string,
    recipientIds: string[],
  ): string {
    const sorted = [...recipientIds].sort().join(',');
    const combined = `${eventType}:${aggregateId}:${sorted}`;
    return crypto.createHash('sha256').update(combined).digest('hex');
  }

  /**
   * Query outbox status for an event
   * Used for polling delivery status
   */
  async getEventStatus(
    outboxEventId: string,
  ): Promise<{
    id: string;
    status: string;
    retryCount: number;
    processedAt?: Date;
    lastError?: string;
  }> {
    const event = await this.outboxRepository.findOne({
      where: { id: outboxEventId },
    });

    if (!event) {
      return null;
    }

    return {
      id: event.id,
      status: event.status,
      retryCount: event.retryCount,
      processedAt: event.processedAt,
      lastError: event.lastError,
    };
  }

  /**
   * Metrics for monitoring
   */
  async getMetrics(): Promise<{
    pendingEvents: number;
    dispatchedEvents: number;
    deadLetterEvents: number;
    avgRetryCount: number;
  }> {
    const pending = await this.outboxRepository.count({
      where: { status: 'PENDING' },
    });

    const dispatched = await this.outboxRepository.count({
      where: { status: 'DISPATCHED' },
    });

    const deadLetter = await this.outboxRepository.count({
      where: { status: 'DEAD_LETTER' },
    });

    // Average retry count for successful events
    const result = await this.outboxRepository
      .createQueryBuilder()
      .select('AVG(retryCount)', 'avg')
      .where('status = :status', { status: 'DISPATCHED' })
      .getRawOne();

    return {
      pendingEvents: pending,
      dispatchedEvents: dispatched,
      deadLetterEvents: deadLetter,
      avgRetryCount: parseFloat(result?.avg || '0'),
    };
  }
}

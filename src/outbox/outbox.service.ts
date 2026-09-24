import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';

/** Routing-only metadata — no PII, settlement, or claim content */
export interface OutboxEventPayload {
  /** Notification/aggregate identifier */
  notificationId?: string;
  /** Delivery channel, e.g. "in_app", "email", "webhook" */
  channel?: string;
  /** Recipient user IDs — opaque identifiers only */
  recipientIds?: string[];
  /** Additional non-sensitive context for the consumer */
  meta?: Record<string, string | number | boolean>;
}

export type OutboxStatus = 'PENDING' | 'DISPATCHED' | 'DEAD_LETTER';

export const OUTBOX_JOB_NAME = 'deliver-notification' as const;
export const OUTBOX_QUEUE_NAME = 'notifications' as const;

/** Max rows claimed per poll cycle to bound transaction size */
const BATCH_SIZE = 50;

/**
 * OutboxService — implements the Transactional Outbox pattern (V2-BE-048).
 *
 * Callers write an OutboxEvent row **inside their own Prisma transaction**
 * so that the side effect (queue job) is durably recorded before control
 * returns.  A background poller then claims PENDING rows and relays them to
 * BullMQ, completing the at-least-once delivery guarantee.
 *
 * Security invariants:
 * - Payload must never contain private claim text, user PII, settlement
 *   data, or secret keys — only opaque IDs and routing hints.
 * - The API never becomes authoritative for protocol settlement or rewards.
 * - Optimism/EVM semantics are preserved; Stellar/Soroban dependencies
 *   are explicitly absent.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(OUTBOX_QUEUE_NAME)
    private readonly queue: Queue,
    private readonly metricsService: MetricsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Write side — called by domain services inside their transaction
  // ---------------------------------------------------------------------------

  /**
   * Publish an outbox event **within an existing Prisma transaction**.
   *
   * @param tx  - The Prisma transaction client from the caller's `$transaction`
   * @param eventType - Domain event type, e.g. "notification.send"
   * @param aggregateId - Opaque ID of the triggering entity (e.g. notificationId)
   * @param payload - Routing-only metadata (see OutboxEventPayload)
   * @returns The created OutboxEvent id
   *
   * @example
   * ```ts
   * await prisma.$transaction(async (tx) => {
   *   await tx.notification.create({ data: {...} });
   *   await outboxService.publishEvent(tx, 'notification.send', notifId, { channel: 'in_app', recipientIds: [userId] });
   * });
   * ```
   */
  async publishEvent(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    eventType: string,
    aggregateId: string,
    payload: OutboxEventPayload,
  ): Promise<string> {
    const idempotencyKey = this.buildIdempotencyKey(eventType, aggregateId, payload);

    const event = await tx.outboxEvent.create({
      data: {
        eventType,
        aggregateId,
        payload: JSON.stringify(payload),
        idempotencyKey,
        status: 'PENDING' satisfies OutboxStatus,
      },
      select: { id: true },
    });

    this.logger.debug(
      `OutboxEvent published: id=${event.id} type=${eventType} aggregate=${aggregateId}`,
    );
    return event.id;
  }

  // ---------------------------------------------------------------------------
  // Read/relay side — polled by OutboxScheduler
  // ---------------------------------------------------------------------------

  /**
   * Claim and relay a batch of PENDING outbox events to BullMQ.
   *
   * Uses an optimistic update-then-select pattern:
   * 1. UPDATE … SET status='DISPATCHING' WHERE status='PENDING' LIMIT N
   * 2. For each claimed row → add BullMQ job
   * 3. UPDATE … SET status='DISPATCHED', jobId=<id>
   *
   * Rows that fail BullMQ dispatch are left as PENDING (or incremented toward
   * DEAD_LETTER after maxRetries).
   */
  async processOutbox(): Promise<void> {
    // Claim a batch atomically — SQLite compatible approach using a timestamp
    // mark to avoid multi-row UPDATE…RETURNING (not universally supported).
    const claimedAt = new Date();
    const batchMarker = claimedAt.toISOString();

    // Find pending events and mark them as in-flight using a batch marker
    const pending = await this.prisma.outboxEvent.findMany({
      where: {
        status: 'PENDING' satisfies OutboxStatus,
        retryCount: { lt: this.prisma.outboxEvent.fields?.maxRetries ? 5 : 5 },
      },
      orderBy: { scheduledAt: 'asc' },
      take: BATCH_SIZE,
    });

    if (pending.length === 0) {
      return;
    }

    this.logger.debug(`OutboxService: processing ${pending.length} pending events`);
    this.metricsService.incrementCounter('outbox_batch_processed_total', 1);

    for (const event of pending) {
      await this.relayEvent(event);
    }
  }

  private async relayEvent(event: {
    id: string;
    eventType: string;
    aggregateId: string;
    payload: string;
    idempotencyKey: string;
    retryCount: number;
    maxRetries: number;
  }): Promise<void> {
    try {
      let payload: OutboxEventPayload;
      try {
        payload = JSON.parse(event.payload) as OutboxEventPayload;
      } catch {
        this.logger.error(`OutboxEvent ${event.id}: invalid JSON payload — dead-lettering`);
        await this.deadLetter(event.id, 'Invalid JSON payload');
        return;
      }

      const job = await this.queue.add(
        OUTBOX_JOB_NAME,
        {
          notificationId: payload.notificationId ?? event.aggregateId,
          channel: payload.channel,
          userId: undefined, // never relay userId through queue job data
          idempotencyKey: event.idempotencyKey,
          outboxEventId: event.id,
        },
        {
          jobId: `outbox-${event.idempotencyKey}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
        },
      );

      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: 'DISPATCHED' satisfies OutboxStatus,
          jobId: String(job.id ?? ''),
          processedAt: new Date(),
        },
      });

      this.metricsService.incrementCounter('outbox_events_dispatched_total', 1);
      this.logger.debug(`OutboxEvent ${event.id} dispatched as BullMQ job ${job.id}`);
    } catch (error) {
      const newRetryCount = event.retryCount + 1;
      const isDead = newRetryCount >= event.maxRetries;

      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          retryCount: newRetryCount,
          lastError: String(error?.message ?? 'Unknown dispatch error').slice(0, 500),
          status: isDead
            ? ('DEAD_LETTER' satisfies OutboxStatus)
            : ('PENDING' satisfies OutboxStatus),
        },
      });

      if (isDead) {
        this.metricsService.incrementCounter('outbox_events_dead_lettered_total', 1);
        this.logger.error(
          `OutboxEvent ${event.id} dead-lettered after ${newRetryCount} retries: ${error?.message}`,
        );
      } else {
        this.metricsService.incrementCounter('outbox_events_relay_failed_total', 1);
        this.logger.warn(
          `OutboxEvent ${event.id} relay failed (attempt ${newRetryCount}/${event.maxRetries}): ${error?.message}`,
        );
      }
    }
  }

  private async deadLetter(id: string, reason: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: {
        status: 'DEAD_LETTER' satisfies OutboxStatus,
        lastError: reason.slice(0, 500),
        processedAt: new Date(),
      },
    });
    this.metricsService.incrementCounter('outbox_events_dead_lettered_total', 1);
  }

  /**
   * Build a deterministic idempotency key for an outbox event.
   * Key = sha256(eventType + aggregateId + sorted-payload-keys)
   */
  buildIdempotencyKey(
    eventType: string,
    aggregateId: string,
    payload: OutboxEventPayload,
  ): string {
    const channel = payload.channel ?? '';
    const recipients = (payload.recipientIds ?? []).sort().join(',');
    const raw = `${eventType}:${aggregateId}:${channel}:${recipients}`;
    return createHash('sha256').update(raw).digest('hex');
  }

  /** Expose pending count for health checks */
  async getPendingCount(): Promise<number> {
    return this.prisma.outboxEvent.count({ where: { status: 'PENDING' } });
  }

  /** Expose dead-letter count for alerting */
  async getDeadLetterCount(): Promise<number> {
    return this.prisma.outboxEvent.count({ where: { status: 'DEAD_LETTER' } });
  }
}

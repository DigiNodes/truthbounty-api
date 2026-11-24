import { getRuntimeEnvironment } from '../config/runtime-config';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  V2OutboxMessage,
  V2OutboxStatus,
} from '../v2/outbox/entities/v2-outbox-message.entity';
import {
  OperationsQueueSource,
  OperationsRetrySourceResult,
} from './operations-queue.source';
import {
  AuthoritySource,
  DuplicationRisk,
  FreshnessState,
  OperationalCapability,
  OperationalImpact,
  OperationalQueueItem,
  QueueItemStatus,
} from './operations.types';

/**
 * Default {@link OperationsQueueSource}: exposes the canonical V2 TypeORM
 * transactional outbox (`v2_outbox_messages`) as operational items.
 *
 * Read-only with respect to protocol state. `retry` re-enqueues an existing
 * dead-lettered row by moving it back to `PENDING`; it keeps the row's
 * deterministic `idempotencyKey`, so the delivery is idempotent and no second
 * chain submission or projection effect is created.
 */
@Injectable()
export class OutboxOperationsQueueSource implements OperationsQueueSource {
  constructor(
    @InjectRepository(V2OutboxMessage)
    private readonly outbox: Repository<V2OutboxMessage>,
  ) {}

  private get releaseId(): string {
    return getRuntimeEnvironment().RELEASE_ID ?? 'unreleased';
  }

  async list(): Promise<OperationalQueueItem[]> {
    const rows = await this.outbox.find({
      order: { updatedAt: 'DESC' },
      take: 500,
    });
    return rows.map((row) => this.toItem(row));
  }

  async get(id: string): Promise<OperationalQueueItem | null> {
    const row = await this.outbox.findOne({ where: { id } });
    return row ? this.toItem(row) : null;
  }

  async retry(id: string): Promise<OperationsRetrySourceResult> {
    // Re-enqueue the existing row in place. The deterministic idempotencyKey is
    // preserved, so the worker cannot double-deliver.
    const updated = await this.outbox.update(
      { id, status: V2OutboxStatus.DEAD_LETTER },
      {
        status: V2OutboxStatus.PENDING,
        lastError: null,
        scheduledAt: new Date(),
      },
    );

    if (!updated.affected) {
      return {
        replayed: 0,
        skipped: 1,
        failed: 0,
        detail: 'item is not in DEAD_LETTER state',
      };
    }
    return { replayed: 1, skipped: 0, failed: 0, detail: null };
  }

  private toItem(row: V2OutboxMessage): OperationalQueueItem {
    const status = this.mapStatus(row.status);
    const retryable = status === QueueItemStatus.FAILED;

    return {
      id: row.id,
      releaseId: this.releaseId,
      capability: OperationalCapability.RETRY_SUBMIT,
      authoritySource: AuthoritySource.SYSTEM,
      authorityExpiresAt: null,
      status,
      impact: OperationalImpact.MEDIUM,
      duplicationRisk: DuplicationRisk.IDEMPOTENT_REPLAY,
      freshness: FreshnessState.FRESH,
      attempts: row.retryCount,
      maxAttempts: row.maxRetries,
      retryable,
      version: String(row.updatedAt.getTime()),
      updatedAt: row.updatedAt.toISOString(),
      summary: `outbox event: ${row.eventType}`,
    };
  }

  private mapStatus(status: V2OutboxStatus): QueueItemStatus {
    switch (status) {
      case V2OutboxStatus.PENDING:
        return QueueItemStatus.PENDING;
      case V2OutboxStatus.PROCESSING:
        return QueueItemStatus.IN_PROGRESS;
      case V2OutboxStatus.DISPATCHED:
        return QueueItemStatus.COMPLETED;
      default:
        // DEAD_LETTER and any unknown state fail closed: reported as failed and
        // never treated as done.
        return QueueItemStatus.FAILED;
    }
  }
}

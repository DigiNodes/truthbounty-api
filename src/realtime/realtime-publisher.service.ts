import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ProjectionEvent } from './entities/projection-event.entity';
import { RealtimeBusService } from './realtime-bus.service';
import { RealtimeConfigService } from './realtime-config.service';
import { IndexedEvent } from '../entities';
import { ProjectionEventType, RealtimeEnvelopeType } from './realtime.enums';

/**
 * Polls the committed projection outbox and broadcasts newly committed rows to
 * the realtime bus.
 *
 * Delivery-after-commit guarantee: rows are only selectable after their
 * writing transaction commits, so nothing is published prematurely. Failed
 * publishes leave the row un-published and are retried on a later pass.
 *
 * Rollback/replacement: the monitor also detects when a projection previously
 * emitted as finalized corresponds to an `IndexedEvent` that the chain indexer
 * has since un-finalized (reorg). In that case a ROLLBACK outbox row is recorded
 * (deduplicated) so clients receive an explicit rollback/replacement message.
 *
 * The batch is bounded to keep each poll cheap and predictable, and rows are
 * claimed with `FOR UPDATE SKIP LOCKED` so multiple instances do not double-publish.
 */
@Injectable()
export class RealtimePublisherService {
  private readonly logger = new Logger(RealtimePublisherService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly bus: RealtimeBusService,
    private readonly configService: RealtimeConfigService,
  ) {}

  @Cron(CronExpression.EVERY_SECOND)
  async publishPending(): Promise<void> {
    const config = this.configService.getConfig();
    // Never run a poll more often than configured.
    if (Date.now() - this.lastPollAt < config.pollIntervalMs) {
      return;
    }
    this.lastPollAt = Date.now();
    await this.publishOnce(config.maxPublishBatch);
    await this.detectRollbacks();
  }

  private lastPollAt = 0;

  /**
   * Publish up to `maxPublishBatch` committed, un-published outbox rows, then
   * mark them published. Each row is emitted only after its transaction
   * committed (a precondition of it being visible here).
   */
  async publishOnce(maxBatch: number): Promise<number> {
    let published = 0;
    let rows: ProjectionEvent[] = [];

    do {
      rows = await this.claimUnpublished(maxBatch);

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        try {
          await this.publishRow(row);
          published += 1;
        } catch (err) {
          // A failed row stays unpublished and is retried next pass. Log and
          // continue with the rest of the batch.
          this.logger.error(
            `Failed to publish outbox row #${row.id}: ${(err as Error)?.message ?? err}`,
          );
        }
      }
    } while (rows.length === maxBatch);

    return published;
  }

  /**
   * Atomically claim up to `max` un-published outbox rows, skipping rows
   * already locked by another publisher instance.
   */
  private async claimUnpublished(max: number): Promise<ProjectionEvent[]> {
    return this.dataSource.transaction(async (manager) => {
      return manager.getRepository(ProjectionEvent).find({
        where: { published: false },
        order: { id: 'ASC' },
        take: max,
        lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' },
      });
    });
  }

  private async publishRow(row: ProjectionEvent): Promise<void> {
    this.bus.publish({
      cursor: row.id,
      sourceCursor: row.id,
      type:
        row.eventType === ProjectionEventType.ROLLBACK
          ? RealtimeEnvelopeType.ROLLBACK
          : RealtimeEnvelopeType.EVENT,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      data: row.payload,
      timestamp: (row.createdAt ?? new Date()).toISOString(),
    });

    await this.dataSource
      .getRepository(ProjectionEvent)
      .createQueryBuilder()
      .update()
      .set({ published: true, publishedAt: new Date() })
      .where('id = :id', { id: row.id })
      .execute();
  }

  /**
   * Detect projections that were emitted as finalized but whose source indexed
   * event has been un-finalized by the chain indexer (reorg), and record a
   * deduplicated ROLLBACK outbox row for them.
   */
  private async detectRollbacks(): Promise<void> {
    try {
      // Find finalized projection rows that carry a correlationId (indexed
      // event transaction hash) and have not already been superseded by a
      // rollback row.
      const finalizedRows = await this.dataSource
        .getRepository(ProjectionEvent)
        .find({
          where: { finalized: true, published: true },
          take: 200,
        });

      const correlating = finalizedRows.filter((r) => !!r.correlationId);
      if (correlating.length === 0) {
        return;
      }

      const txHashes = [...new Set(correlating.map((r) => r.correlationId!))];

      const events = await this.dataSource
        .getRepository(IndexedEvent)
        .createQueryBuilder('ie')
        .where('ie.transactionHash IN (:...txHashes)', { txHashes })
        .select(['ie.transactionHash', 'ie.isFinalized', 'ie.blockNumber'])
        .getMany();

      const unfinalizedTxs = new Set<string>();
      for (const ev of events) {
        if (ev.isFinalized === false) {
          unfinalizedTxs.add(ev.transactionHash);
        }
      }

      for (const row of correlating) {
        if (unfinalizedTxs.has(row.correlationId!)) {
          const already = await this.dataSource
            .getRepository(ProjectionEvent)
            .createQueryBuilder('pe')
            .where('pe.aggregateType = :t', { t: row.aggregateType })
            .andWhere('pe.aggregateId = :id', { id: row.aggregateId })
            .andWhere('pe.eventType = :et', {
              et: ProjectionEventType.ROLLBACK,
            })
            .andWhere('pe.correlationId = :c', { c: row.correlationId })
            .andWhere('pe.published = :p', { p: false })
            .getCount();

          if (already === 0) {
            const rollback = this.dataSource
              .getRepository(ProjectionEvent)
              .create({
                aggregateType: row.aggregateType,
                aggregateId: row.aggregateId,
                eventType: ProjectionEventType.ROLLBACK,
                payload: { replaced: true, reason: 'reorg' },
                finalized: true,
                published: false,
                correlationId: row.correlationId,
              });
            await this.dataSource.getRepository(ProjectionEvent).save(rollback);
            this.logger.warn(
              `Recorded rollback for ${row.aggregateType}:${row.aggregateId} (reorg: ${row.correlationId})`,
            );
          }
        }
      }
    } catch (error) {
      this.logger.error(
        `Rollback detection failed: ${(error as Error)?.message ?? error}`,
      );
    }
  }
}

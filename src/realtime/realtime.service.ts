import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Observable } from 'rxjs';
import { ProjectionEvent } from './entities/projection-event.entity';
import { RealtimeBusService } from './realtime-bus.service';
import { RealtimeConfigService } from './realtime-config.service';
import {
  ProjectionChange,
  RealtimeEnvelope,
  RealtimeStreamOptions,
} from './realtime.types';
import { ProjectionEventType, RealtimeEnvelopeType } from './realtime.enums';

const MAX_AGGREGATE_TYPE = 128;
const MAX_AGGREGATE_ID = 128;
const MAX_CORRELATION_ID = 128;

/**
 * Core service for the projection-backed realtime event stream.
 *
 *  - Recording: {@link emitWithinTransaction} appends a {@link ProjectionEvent}
 *    outbox row using the supplied {@link EntityManager}. Because the row is
 *    written inside the caller's database transaction, it only becomes visible
 *    to the publisher after that transaction commits — fulfilling the
 *    "publish normalized projection changes only after their database
 *    transaction commits" requirement.
 *
 *  - Delivery: {@link streamFrom} builds an SSE-friendly {@link Observable}
 *    that first replays committed outbox rows after a resume cursor, then
 *    subscribes to the live in-process bus. It emits heartbeats and enforces
 *    bounded backpressure.
 *
 * Validation of untrusted input happens here (and in the DTO) so the boundary
 * fails closed on malformed data rather than misbehaving.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(
    @InjectRepository(ProjectionEvent)
    private readonly eventRepository: Repository<ProjectionEvent>,
    private readonly bus: RealtimeBusService,
    private readonly configService: RealtimeConfigService,
  ) {}

  /**
   * Record a projection change within the given database transaction.
   *
   * @param manager the in-progress transaction manager (commits are the
   *                caller's responsibility; the row surfaces only on commit).
   * @param change the normalized projection change to record.
   * @throws if the input fails validation.
   */
  async emitWithinTransaction(
    manager: EntityManager,
    change: ProjectionChange,
  ): Promise<ProjectionEvent> {
    this.validate(change);

    const event = manager.getRepository(ProjectionEvent).create({
      ...change,
      aggregateType: change.aggregateType.trim(),
      aggregateId: change.aggregateId.trim(),
      finalized: change.finalized ?? false,
      correlationId: change.correlationId?.trim() || null,
      published: false,
      publishedAt: null,
      revision: 0,
    });

    const saved = await manager
      .getRepository(ProjectionEvent)
      .save(event as Partial<ProjectionEvent>);

    this.logger.debug(
      `Recorded projection change #${saved.id} (${saved.eventType}) for ${saved.aggregateType}:${saved.aggregateId}`,
    );
    return saved;
  }

  /**
   * Convenience for emitting a rollback/replacement for a previously emitted
   * projection. Same transaction semantics as {@link emitWithinTransaction};
   * the emitted column is left false so it is not delivered as a normal change.
   *
   * @param manager the in-progress transaction manager.
   */
  async emitRollback(
    manager: EntityManager,
    params: {
      aggregateType: string;
      aggregateId: string;
      payload?: Record<string, any>;
      correlationId?: string;
    },
  ): Promise<ProjectionEvent> {
    return this.emitWithinTransaction(manager, {
      aggregateType: params.aggregateType,
      aggregateId: params.aggregateId,
      eventType: ProjectionEventType.ROLLBACK,
      payload: params.payload ?? { replaced: true },
      finalized: true,
      correlationId: params.correlationId,
    });
  }

  /**
   * Build a realtime stream observable for a single SSE client.
   *
   * @param options resume cursor / heartbeat / backpressure tuning.
   */
  streamFrom(
    options: RealtimeStreamOptions = {},
  ): Observable<RealtimeEnvelope> {
    const config = this.configService.getConfig();
    const afterId = options.afterId ?? 0;
    const heartbeatMs =
      options.heartbeatIntervalMs ?? config.heartbeatIntervalMs;
    const maxBacklog = options.maxBacklog ?? config.maxBacklog;
    const maxReplay = config.maxReplayRows;

    return new Observable<RealtimeEnvelope>((subscriber) => {
      let settled = false;
      let replayDone = false;

      const push = (envelope: RealtimeEnvelope) => {
        if (settled) return;
        subscriber.next(envelope);
      };

      // Heartbeat on idle connections so proxies and clients don't drop us.
      const heartbeatId = setInterval(() => {
        if (settled) return;
        push({
          cursor: 0,
          type: RealtimeEnvelopeType.HEARTBEAT,
          heartbeat: true,
          timestamp: new Date().toISOString(),
        });
      }, heartbeatMs);

      // Live delivery from the in-process bus. Rows are only delivered here
      // after their writing transaction committed. The bus enforces bounded
      // per-subscriber backpressure; if it closes us, surface that to the
      // stream subscriber so the SSE layer can respond (e.g. 503).
      const liveSubscription = this.bus.subscribe(
        (envelope) => {
          if (!replayDone) return;
          if (settled) return;
          subscriber.next(envelope);
        },
        {
          capacity: maxBacklog,
          error: (err) => {
            if (settled) return;
            subscriber.error(err);
            tearDown();
          },
        },
      );

      const tearDown = () => {
        if (settled) return;
        settled = true;
        if (heartbeatId) clearInterval(heartbeatId);
        liveSubscription?.unsubscribe();
      };

      (async () => {
        // Replay committed outbox rows after the resume cursor (deterministic
        // order, bounded window for memory safety).
        const query = this.eventRepository
          .createQueryBuilder('pe')
          .where('pe.id > :afterId', { afterId })
          .orderBy('pe.id', 'ASC')
          .limit(maxReplay + 1);

        const rows = await query.getMany();
        const overrun = rows.length > maxReplay;
        const replay = rows.slice(0, maxReplay);

        for (const row of replay) {
          push(this.toEnvelope(row));
        }

        if (overrun) {
          this.logger.warn(
            `Resume cursor ${afterId} exceeded replay window (${maxReplay}); truncating`,
          );
        }

        // Acknowledge current position and start accepting live envelopes.
        push({
          cursor: afterId,
          type: RealtimeEnvelopeType.SNAPSHOT,
          timestamp: new Date().toISOString(),
        });
        replayDone = true;

        // Acknowledge we are now live.
      })().catch((err) => {
        if (settled) return;
        subscriber.error(err);
        tearDown();
      });

      return () => tearDown();
    });
  }

  /**
   * Convert a stored outbox row into a public envelope.
   */
  private toEnvelope(row: ProjectionEvent): RealtimeEnvelope {
    if (row.eventType === ProjectionEventType.ROLLBACK) {
      return {
        cursor: row.id,
        sourceCursor: row.id,
        type: RealtimeEnvelopeType.ROLLBACK,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        data: row.payload ?? { replaced: true },
        timestamp: (row.createdAt ?? new Date()).toISOString(),
      };
    }
    return {
      cursor: row.id,
      sourceCursor: row.id,
      type:
        row.eventType === ProjectionEventType.CREATED
          ? RealtimeEnvelopeType.EVENT
          : RealtimeEnvelopeType.EVENT,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      data: row.payload,
      timestamp: (row.createdAt ?? new Date()).toISOString(),
    };
  }

  /**
   * Validate a projection change at the boundary. Throws on any violation so
   * the system fails closed rather than persisting malformed data.
   */
  private validate(change: ProjectionChange): void {
    const type = change.aggregateType?.trim();
    const aggregateId = change.aggregateId?.trim();

    if (!type || type.length === 0 || type.length > MAX_AGGREGATE_TYPE) {
      throw new Error(
        `Invalid aggregateType: must be 1..${MAX_AGGREGATE_TYPE} characters`,
      );
    }
    if (
      !aggregateId ||
      aggregateId.length === 0 ||
      aggregateId.length > MAX_AGGREGATE_ID
    ) {
      throw new Error(
        `Invalid aggregateId: must be 1..${MAX_AGGREGATE_ID} characters`,
      );
    }
    if (!Object.values(ProjectionEventType).includes(change.eventType)) {
      throw new Error(`Invalid eventType: ${String(change.eventType)}`);
    }
    if (change.payload === undefined || change.payload === null) {
      throw new Error('Invalid payload: must be an object');
    }
    if (typeof change.payload !== 'object' || Array.isArray(change.payload)) {
      throw new Error('Invalid payload: must be a plain object');
    }
    if (
      change.correlationId != null &&
      (typeof change.correlationId !== 'string' ||
        change.correlationId.trim().length === 0 ||
        change.correlationId.trim().length > MAX_CORRELATION_ID)
    ) {
      throw new Error(
        `Invalid correlationId: must be 1..${MAX_CORRELATION_ID} characters`,
      );
    }
  }
}

/**
 * Thrown when a stream client cannot keep up with the bounded backlog limit.
 */
export class RealtimeBackpressureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealtimeBackpressureError';
  }
}

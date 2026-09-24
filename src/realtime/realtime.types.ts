import { ProjectionEventType, RealtimeEnvelopeType } from './realtime.enums';

/**
 * A normalized projection change to be recorded in the outbox within the
 * caller's database transaction.
 */
export interface ProjectionChange {
  /**
   * High-level aggregate/domain (e.g. 'claim').
   */
  aggregateType: string;

  /**
   * Identifier of the aggregate within its type.
   */
  aggregateId: string;

  /**
   * Kind of projection change.
   */
  eventType: ProjectionEventType;

  /**
   * Normalized projection payload.
   */
  payload: Record<string, any>;

  /**
   * Whether the change is already reorg-safe/finalized.
   */
  finalized?: boolean;

  /**
   * Optional correlation identifier (useful for rollback envelopes).
   */
  correlationId?: string;
}

/**
 * A single envelope delivered over the realtime stream.
 */
export interface RealtimeEnvelope {
  /**
   * Monotonic cursor identifying this envelope. Stable for replay.
   */
  cursor: number;

  /**
   * Envelope kind.
   */
  type: RealtimeEnvelopeType;

  /**
   * Domain/type of the aggregate. Present for EVENT/ROLLBACK envelopes.
   */
  aggregateType?: string;

  /**
   * Aggregate identifier. Present for EVENT/ROLLBACK envelopes.
   */
  aggregateId?: string;

  /**
   * Normalized projection payload. Present for EVENT envelopes.
   */
  data?: Record<string, any>;

  /**
   * Individual cursor of the source outbox row (differs from envelope cursor
   * for ROLLBACK envelopes, which may reference a previously emitted row).
   */
  sourceCursor?: number;

  /**
   * Server-generated timestamp (ISO string) when the envelope was produced.
   */
  timestamp: string;

  /**
   * Zero-length payload marker for HEARTBEAT envelopes.
   */
  heartbeat?: boolean;
}

/**
 * Options used when opening a realtime stream for a client.
 */
export interface RealtimeStreamOptions {
  /**
   * Resume cursor: replay committed envelopes with source cursor strictly
   * greater than this value before switching to live delivery.
   */
  afterId?: number;

  /**
   * Heartbeat interval in milliseconds.
   */
  heartbeatIntervalMs?: number;

  /**
   * Maximum in-flight (queued) envelopes accepted before the client is
   * considered too slow and the connection dropped (bounded backpressure).
   */
  maxBacklog?: number;
}

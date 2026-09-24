/**
 * Kinds of projection changes recorded in the realtime outbox.
 */
export enum ProjectionEventType {
  /**
   * A projection was created.
   */
  CREATED = 'created',

  /**
   * An existing projection was updated/replaced.
   */
  UPDATED = 'updated',

  /**
   * A previously emitted projection was found to be non-finalized (e.g. a chain
   * reorg) and must be rolled back / replaced by consumers.
   */
  ROLLBACK = 'rollback',
}

/**
 * Envelope types delivered over the realtime SSE stream.
 */
export enum RealtimeEnvelopeType {
  /**
   * Sent on (re)connection to acknowledge a successful, authenticated stream
   * and the current resume cursor.
   */
  SNAPSHOT = 'snapshot',

  /**
   * A normalized projection change.
   */
  EVENT = 'event',

  /**
   * A rollback/replacement of a previously emitted, non-finalized projection.
   */
  ROLLBACK = 'rollback',

  /**
   * Periodic keep-alive sent to idle connections.
   */
  HEARTBEAT = 'heartbeat',
}

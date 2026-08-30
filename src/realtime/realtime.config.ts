/**
 * Configuration for the projection-backed realtime event stream.
 *
 * All values are validated and fail closed: an explicitly provided but
 * invalid value is rejected rather than silently downgraded.
 */
export interface RealtimeConfig {
  /**
   * How often the outbox publisher polls for committed, unpublished rows (ms).
   */
  pollIntervalMs: number;

  /**
   * Maximum number of outbox rows published in a single pass (bounded batch).
   */
  maxPublishBatch: number;

  /**
   * Default heartbeat interval sent on idle streams (ms).
   */
  heartbeatIntervalMs: number;

  /**
   * Maximum queued envelopes per stream before the client is disconnected
   * (bounded backpressure).
   */
  maxBacklog: number;

  /**
   * Maximum number of historical outbox rows replayed for a resuming client.
   * Bounds memory and prevents unbounded cursor replay.
   */
  maxReplayRows: number;
}

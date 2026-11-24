import { OperationalQueueItem } from './operations.types';

/** Injection token for the operational queue read/retry source. */
export const OPERATIONS_QUEUE_SOURCE = Symbol('OPERATIONS_QUEUE_SOURCE');

/** Outcome of asking the source to re-enqueue one item. */
export interface OperationsRetrySourceResult {
  replayed: number;
  skipped: number;
  failed: number;
  detail: string | null;
}

/**
 * Pluggable read/retry source for the operational queue.
 *
 * Implementations MUST be read-only with respect to protocol state: `retry`
 * may only re-enqueue work that already exists and carries its own
 * deterministic idempotency key. It must never submit a new chain transaction
 * or create a new projection effect.
 */
export interface OperationsQueueSource {
  /** All operational items, most recently updated first. */
  list(): Promise<OperationalQueueItem[]>;
  /** One item by immutable id, or null when unknown. */
  get(id: string): Promise<OperationalQueueItem | null>;
  /** Re-enqueue one item. */
  retry(
    id: string,
    options: { requestedBy?: string; reason?: string; force?: boolean },
  ): Promise<OperationsRetrySourceResult>;
}

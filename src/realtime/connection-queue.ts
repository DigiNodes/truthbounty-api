/*
 * Bounded per-connection queue for realtime delivery.
 *
 * Provides a fair, memory-bounded buffer for a single consumer connection. When the
 * consumer cannot keep up, the queue enforces a drop/disconnect policy and exposes a
 * resumable recovery path (catch-up handoff) without logging protected payloads.
 *
 * Design goals:
 *   - Memory / queue growth is bounded by a configured max item count and byte cap.
 *   - One slow client cannot exhaust shared worker memory.
 *   - Dropped clients receive a resumable recovery path (cursor / sequence handov).
 *   - Other clients remain unaffected (isolated per-connection state).
 *   - No protected payload is logged during overflow (byte counts and metadata only).
 */

export type QueueDropReason =
  | 'queue-overflow-count'
  | 'queue-overflow-bytes'
  | 'heartbeat-loss'
  | 'shutdown';

/**
 * Minimal metadata attached to every queued envelope. This is safe to log and
 * is used to build the resumable catch-up handoff. The actual payload is never
 * logged.
 */
export interface QueueEnvelopeMeta {
  /** Monotonically increasing sequence number for this connection. */
  readonly sequence: number;
  /** Canonical event identifier (if available). */
  readonly eventId?: string;
  /** Chain ID the event belongs to (fail-closed binding). */
  readonly chainId?: string;
  /** Release ID associated with the event. */
  readonly releaseId?: string;
  /** Deployment block associated with the event. */
  readonly deploymentBlock?: number;
  /** Artifact checksum for tamper-evident binding. */
  readonly artifactChecksum?: string;
  /** Enqueue timestamp (ms) for latency metrics. */
  readonly enqueuedAt: number;
  /** Serialized size in bytes (for byte-bound enforcement). */
  readonly bytes: number;
}

export interface QueuedItem<T> {
  readonly meta: QueueEnvelopeMeta;
  readonly payload: T;
}

/**
 * Resumable recovery path handed to a dropped client. Contains only cursor /
 * metadata - not payloads - so it is safe to transport over a reconnect channel.
 */
export interface RecoveryHandoff {
  /** The connection identifier that was dropped. */
  readonly connectionId: string;
  /** Why the consumer was dropped. */
  readonly reason: QueueDropReason;
  /** Last sequence successfully delivered to the client. */
  readonly lastDeliveredSequence: number;
  /** Next sequence the client should resume from. */
  readonly resumeFromSequence: number;
  /** Highest sequence that was ever enqueued (catch-up upper bound). */
  readonly lastEnqueuedSequence: number;
  /** Number of items dropped due to overflow. */
  readonly droppedCount: number;
  /** Number of bytes dropped due to overflow. */
  readonly droppedBytes: number;
  /** When the handoff was created. */
  readonly createdAt: number;
}

export interface ConnectionQueueOptions {
  /** Stable connection identifier for metrics and handoff. */
  readonly connectionId: string;
  /** Maximum number of items buffered. Default 256. */
  readonly maxItems?: number;
  /** Maximum total bytes buffered. Default 2 MiB. */
  readonly maxBytes?: number;
  /** Heartbeat interval in ms. Default 30_000. */
  readonly heartbeatIntervalMs?: number;
  /** Max allowed silence before heartbeat loss. Default 90_000. */
  readonly heartbeatTimeoutMs?: number;
  /** Clock injection for testability. Default Date.now. */
  readonly now?: () => number;
  /** Optional callback invoked when the consumer is dropped. */
  readonly onDrop?: (handoff: RecoveryHandoff) => void;
}

export interface EnqueueResult {
  /** Whether the item was accepted into the queue. */
  readonly accepted: boolean;
  /** Sequence assigned to the item (even if dropped). */
  readonly sequence: number;
  /** Reason for drop if not accepted. */
  readonly dropReason?: QueueDropReason;
}

const DEFAULT_MAX_ITEMS = 256;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90_000;

/**
 * A bounded per-connection queue with slow-consumer isolation.
 *
 * The queue is the only place where a single connection's backlog is held. It is
 * deliberately not shared between connections, so a slow consumer cannot exhaust
 * shared worker memory. Once the capacity (by count or by bytes) is exceeded, the
 * consumer is dropped and a resumable recovery handoff is emitted.
 */
export class ConnectionQueue<T = unknown> {
  private readonly connectionId: string;
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly now: () => number;
  private readonly onDrop?: (handoff: RecoveryHandoff) => void;

  private readonly buffer: QueuedItem<T>[] = [];
  private bufferedBytes = 0;
  private nextSequence = 1;
  private lastDeliveredSequence = 0;
  private lastEnqueuedSequence = 0;
  private dropped = false;
  private dropReason: QueueDropReason | undefined;
  private droppedCount = 0;
  private droppedBytes = 0;
  private lastHeartbeatAat: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ConnectionQueueOptions) {
    if (!options || typeof options.connectionId !== 'string' || options.connectionId === '') {
      throw new TypeError('ConnectionQueue requires a non-empty connectionId');
    }
    this.connectionId = options.connectionId;
    this.maxItems = normalizePositiveInt(options.maxItems, DEFAULT_MAX_ITEMS, 'maxItems');
    this.maxBytes = normalizePositiveInt(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
    this.heartbeatIntervalMs = normalizePositiveInt(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      'heartbeatIntervalMs',
    );
    this.heartbeatTimeoutMs = normalizePositiveInt(
      options.heartbeatTimeoutMs,
      DEFAULT_HEARTBEAT_TIMEOUT_MS,
      'heartbeatTimeoutMs',
    );
    this.now = options.now ?? (() => Date.now());
    this.onDrop = options.onDrop;
    this.lastHeartbeatAat = this.now();
  }

  /** Current number of buffered items. */
  get size(): number {
    return this.buffer.length;
  }

  /** Current number of buffered bytes. */
  get bytesBuffered(): number {
    return this.bufferedBytes;
  }

  /** Whether this consumer has been dropped. */
  get isDropped(): boolean {
    return this.dropped;
  }

  /** Reason the consumer was dropped, if any. */
  get dropReasonDetail(): QueueDropReason | undefined {
    return this.dropReason;
  }

  /** Highest sequence ever enqueued for this connection. */
  get lastEnqueued(): number {
    return this.lastEnqueuedSequence;
  }

  /** Last sequence successfully delivered to the consumer. */
  get lastDelivered(): number {
    return this.lastDeliveredSequence;
  }

  /**
   * Enqueue an item for delivery. The queue enforces both count and byte caps.
   * If either cap is exceeded, the consumer is dropped and the item is not
   * accepted. The payload is never logged - only metadata and byte counts.
   */
  enqueue(payload: T, meta?: Omit<QueueEnvelopeMeta, 'sequence' | 'enqueuedAt' | 'bytes'>): EnqueueResult {
    const sequence = this.nextSequence++;
    this.lastEnqueuedSequence = sequence;

    if (this.dropped) {
      this.droppedCount += 1;
      return { accepted: false, sequence, dropReason: this.dropReason };
    }

    const bytes = measureBytes(payload);
    const nextCount = this.buffer.length + 1;
    const nextBytes = this.bufferedBytes + bytes;

    if (nextCount > this.maxItems) {
      this.droppedCount += 1;
      this.droppedBytes += bytes;
      this.dropWithReason('queue-overflow-count');
      return { accepted: false, sequence, dropReason: 'queue-overflow-count' };
    }

    if (nextBytes > this.maxBytes) {
      this.droppedCount += 1;
      this.droppedBytes += bytes;
      this.dropWithReason('queue-overflow-bytes');
      return { accepted: false, sequence, dropReason: 'queue-overflow-bytes' };
    }

    const envelope: QueuedItem<T> = {
      meta: {
        sequence,
        eventId: meta?.eventId,
        chainId: meta?.chainId,
        releaseId: meta?.releaseId,
        deploymentBlock: meta?.deploymentBlock,
        artifactChecksum: meta?.artifactChecksum,
        enqueuedAt: this.now(),
        bytes,
      },
      payload,
    };

    this.buffer.push(envelope);
    this.bufferedBytes = nextBytes;
    return { accepted: true, sequence };
  }

  /**
   * De-queue the next item for delivery. Returns undefined when empty or when
   * the consumer has been dropped.
   */
  dequeue(): QueuedItem<T> | undefined {
    if (this.dropped) {
      return undefined;
    }
    const item = this.buffer.shift();
    if (!item) {
      return undefined;
    }
    this.bufferedBytes -= item.meta.bytes;
    if (this.bufferedBytes < 0) {
      this.bufferedBytes = 0;
    }
    this.lastDeliveredSequence = item.meta.sequence;
    return item;
  }

  /**
   * Record a heartbeat from the consumer. Resets the silence timer.
   */
  recordHeartbeat(): void {
    this.lastHeartbeatAt = this.now();
  }

  /**
   * Start a heartbeat monitor that drops the consumer if no heartbeat is
   * received within the configured timeout. Idempotent.
   */
  startHeartbeatMonitor(): void {
    if (this.heartbeatTimer !== undefined || this.dropped) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      this.checkHeartbeat();
    }, this.heartbeatIntervalMs);
    if (typeof (this.heartbeatTimer as { unref?: () => void }).unref === 'function') {
      (this.heartbeatTimer as { unref: () => void }).unref();
    }
  }

  /**
   * Evaluate the heartbeat silence window and drop the consumer if it has
   * expired. Exposed for deterministic testing.
   */
  checkHeartbeat(): void {
    if (this.dropped) {
      return;
    }
    const elapsed = this.now() - this.lastHeartbeatAt;
    if (elapsed > this.heartbeatTimeoutMs) {
      this.dropWithReason('heartbeat-loss');
    }
  }

  /**
   * Build a resumable recovery handoff for this connection. Safe to call at
   * any time; returns metadata only, never payloads.
   */
  buildRecoveryHandoff(reason?: QueueDropReason): RecoveryHandoff {
    return {
      connectionId: this.connectionId,
      reason: reason ?? this.dropReason ?? 'shutdown',
      lastDeliveredSequence: this.lastDeliveredSequence,
      resumeFromSequence: this.lastDeliveredSequence + 1,
      lastEnqueuedSequence: this.lastEnqueuedSequence,
      droppedCount: this.droppedCount,
      droppedBytes: this.droppedBytes,
      createdAt: this.now(),
    };
  }

  /**
   * Drop the consumer with an explicit reason. Clears the buffer to release
   * memory immediately and invokes the onDrop callback once.
   */
  drop(reason: QueueDropReason = 'shutdown'): void {
    this.dropWithReason(reason);
  }

  /**
   * Shut down the queue gracefully: stops timers, drops the consumer, and
   * emits a shutdown recovery handoff.
   */
  shutdown(): RecoveryHandoff {
    const handoff = this.buildRecoveryHandoff('shutdown');
    this.dropWithReason('shutdown', handoff);
    return handoff;
  }

  private dropWithReason(reason: QueueDropReason, prebuilt?: RecoveryHandoff): void {
    if (this.dropped) {
      return;
    }
    this.dropped = true;
    this.dropReason = reason;
    this.clearHeartbeatTimer();

    // Release buffered payloads immediately to bound memory.
    this.buffer.length = 0;
    this.bufferedBytes = 0;

    const handoff = prebuilt ?? this.buildRecoveryHandoff(reason);
    if (this.onDrop) {
      try {
        this.onDrop(handoff);
      } catch {
        // Drop callbacks must not crash the worker or affect other connections.
        // Swallow and continue; the handoff is still returned to the caller.
      }
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}

function normalizePositiveInt(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return Math.floor(value);
}

/**
 * Measure the serialized size of a payload in bytes. Never throws and never
 * logs the payload. Falls back to a conservative estimate when the payload
 * cannot be serialized.
 */
function measureBytes(payload: unknown): number {
  try {
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (typeof serialized === 'string') {
      return Buffer.byteLength(serialized, 'utf8');
    }
  } catch {
    // Fall through to a conservative estimate.
  }
  return 1;
}

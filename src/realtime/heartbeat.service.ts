import { EventEmitter } from 'node:events';

/**
 * Heartbeat service for realtime connections.
 *
 * Tracks per-connection last-seen timestamps and periodically scans for
 * connections that have failed to send a heartbeat within the configured
 * timeout. Timed-out connections are emitted as `expired` so the connection
 * manager can close them and free resources. This is the canonical mechanism
 * for detecting dead/slow consumers that still have an open socket but are no
 * longer participating.
 *
 * Design constraints:
 * - Bounded memory: the internal map is pruned on every scan and on explicit
 *   unregister, so it cannot grow unbounded independently of connections.
 * - No payload logging: only connection identifiers and timing metadata are
 *   ever reported.
 * - Fail closed: any connection whose heartbeat is stale is treated as
 *   expired regardless of other state.
 */

export interface HeartbeatOptions {
  /** Interval between scans, in milliseconds. */
  readonly scanIntervalMs?: number;
  /** Maximum allowed age of a heartbeat before expiry, in milliseconds. */
  readonly timeoutMs?: number;
  /** Maximum number of tracked connections. Fails closed when exceeded. */
  readonly maxTrackedConnections?: number;
  /** Injectable clock for testability. Defaults to Date.now. */
  readonly now?: () => number;
}

export interface HeartbeatRecord {
  readonly connectionId: string;
  readonly lastSeenAt: number;
}

export interface HeartbeatExpiredEvent {
  readonly connectionId: string;
  readonly lastSeenAt: number;
  readonly expiredAt: number;
}

const DEFAULT_SCAN_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_TRACKED = 100_000;

const MIN_SCAN_INTERVAL_MS = 100;
const MIN_TIMEOUT_MS = 100;

export class HeartbeatService extends EventEmitter {
  private readonly connections = new Map<string, number>();
  private readonly scanIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxTrackedConnections: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(options: HeartbeatOptions = {}) {
    super();
    this.scanIntervalMs = Math.max(
      MIN_SCAN_INTERVAL_MS,
      options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS,
    );
    this.timeoutMs = Math.max(
      MIN_TIMEOUT_MS,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    this.maxTrackedConnections = Math.max(
      1,
      options.maxTrackedConnections ?? DEFAULT_MAX_TRACKED,
    );
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Register a connection as alive. Returns false when the tracked-connection
   * capacity is reached, in which case the caller must fail closed and reject
   * the connection rather than grow unbounded memory.
   */
  register(connectionId: string): boolean {
    if (!connectionId) {
      throw new Error('connectionId is required');
    }
    if (!this.connections.has(connectionId) && this.connections.size >= this.maxTrackedConnections) {
      this.pruneExpired();
      if (this.connections.size >= this.maxTrackedConnections) {
        return false;
      }
    }
    this.connections.set(connectionId, this.now());
    return true;
  }

  /**
   * Record a heartbeat for an already-registered connection. Returns false if
   * the connection is not tracked (fail closed -- the caller should reject
   * the frame).
   */
  touch(connectionId: string): boolean {
    if (!this.connections.has(connectionId)) {
      return false;
    }
    this.connections.set(connectionId, this.now());
    return true;
  }

  /**
   * Remove a connection from tracking. Idempotent.
   */
  unregister(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  /**
   * Return a snapshot of tracked connections. Useful for tests and diagnostics.
   */
  snapshot(): HeartbeatRecord[] {
    const out: HeartbeatRecord[] = [];
    for (const [connectionId, lastSeenAt] of this.connections) {
      out.push({ connectionId, lastSeenAt });
    }
    return out;
  }

  size(): number {
    return this.connections.size;
  }

  /**
   * Start the periodic scan. Idempotent.
   */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.timer = setInterval(() => {
      try {
        this.scan();
      } catch (err) {
        // Never log payloads; only the fact of a scan failure.
        this.emit('error', err instanceof Error ? err : new Error('heartbeat scan failed'));
      }
    }, this.scanIntervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * Stop the periodic scan and release all tracked state. Idempotent.
   */
  stop(): void {
    this.started = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.connections.clear();
  }

  /**
   * Alias for {@link stop}. Provided so connection managers can use a single
   * `shutdown` verb across realtime services. Idempotent.
   */
  shutdown(): void {
    this.stop();
  }

  /**
   * Perform a single scan. Expired connections are removed and emitted as
   * `expired` events. Returns the list of expired connection ids.
   */
  scan(): string[] {
    const now = this.now();
    const expired: string[] = [];
    for (const [connectionId, lastSeenAt] of this.connections) {
      if (now - lastSeenAt >= this.timeoutMs) {
        expired.push(connectionId);
        this.connections.delete(connectionId);
        const event: HeartbeatExpiredEvent = {
          connectionId,
          lastSeenAt,
          expiredAt: now,
        };
        this.emit('expired', event);
      }
    }
    return expired;
  }

  /**
   * Prune expired connections without emitting events. Used internally to
   * reclaim capacity before rejecting new registrations.
   */
  private pruneExpired(): void {
    const now = this.now();
    for (const [connectionId, lastSeenAt] of this.connections) {
      if (now - lastSeenAt >= this.timeoutMs) {
        this.connections.delete(connectionId);
      }
    }
  }
}

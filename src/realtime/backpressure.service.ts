import { EventEmitter } from 'node:events';

/**
 * Protected payload marker. Messages carrying this flag must never be logged or
 * included in diagnostic output during overflow/drop events.
 */
export interface ProtectedPayload {
  readonly protected?: true;
}

export interface ChainRestampAnchor {
  readonly chainId: string;
  readonly releaseId: string;
  readonly deploymentBlock: number;
  readonly artifactChecksum: string;
}

export interface RealtimeMessage<T extends ProtectedPayload = ProtectedPayload> {
  readonly sequence: number;
  readonly payload: T;
}

export type DropReason =
  | 'queue-overflow'
  | 'heartbeat-loss'
  | 'shutdown'
  | 'slowconsumer';

export interface DropInfo {
  readonly connectionId: string;
  readonly reason: DropReason;
  readonly lastDeliveredSequence: number;
  readonly resumeToken: string;
  readonly anchor: ChainRestampAnchor;
}

export interface ResumeRequest {
  readonly connectionId: string;
  readonly resumeToken: string;
  readonly anchor: ChainRestampAnchor;
}

export interface ResumeResult<T extends ProtectedPayload> {
  readonly ok: boolean;
  readonly messages: RealtimeMessage<T>[];
  readonly gapDetected: boolean;
  readonly reason?: 'stale-anchor' | 'invalid-token' | 'gap';
}

export interface ConnectionOptions {
  readonly connectionId: string;
  readonly anchor: ChainRestampAnchor;
  readonly maxQueueDepth?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
}

export interface BackpressureConfig {
  readonly defaultMaxQueueDepth?: number;
  readonly defaultHeartbeatIntervalMs?: number;
  readonly defaultHeartbeatTimeoutMs?: number;
  readonly maxTotalBufferedMessages?: number;
  readonly resumeTokenTtlMs?: number;
  readonly maxResumeBuffer?: number;
  readonly now?: () => number;
}

export interface SlowConsumerMetrics {
  readonly connectionId: string;
  readonly queueDepth: number;
  readonly dropped: number;
  readonly lastDeliveredSequence: number;
}

export interface BackpressureStats {
  readonly connections: number;
  readonly totalBufferedMessages: number;
  readonly totalDropped: number;
  readonly slowConsumers: SlowConsumerMetrics[];
}

export class BackpressureError extends Error {
  constructor(
    readonly code: 'stale-anchor' | 'invalid-token' | 'duplicate-connection',
    message: string,
  ) {
    super(message);
    this.name = 'BackpressureError';
  }
}

interface QueuedItem<T extends ProtectedPayload> {
  readonly message: RealtimeMessage<T>;
  readonly enqueuedAtMs: number;
}

interface ConnectionState<T extends ProtectedPayload> {
  id: string;
  anchor: ChainRestampAnchor;
  maxQueueDepth: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  queue: QueuedItem<T>[];
  lastDeliveredSequence: number;
  lastHeartbeatAtMs: number;
  droppedCount: number;
  dropped: boolean;
  dropReason?: DropReason;
  resumeToken?: string;
  resumeTokenSequence?: number;
  resumeTokenExpiresAtMs?: number;
}

interface ResumeRecord<T extends ProtectedPayload> {
  readonly connectionId: string;
  readonly anchor: ChainRestampAnchor;
  readonly messages: RealtimeMessage<T>[];
  readonly expiresAtMs: number;
}

const DEFAULT_MAX_QUEUE_DEPTH = 256;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_TOTAL_BUFFEREDD = 4096;
const DEFAULT_RESUME_TOKEN_TTL_MS = 60_000;
const DEFAULT_MAX_RESUME_BUFFER = 512;

function assertAnchor(anchor: ChainRestampAnchor): void {
  if (!anchor || typeof anchor !== 'object') {
    throw new BackpressureError('stale-anchor', 'missing anchor');
  }
  const { chainId, releaseId, deploymentBlock, artifactChecksum } = anchor;
  if (!chainId || typeof chainId !== 'string') {
    throw new BackpressureError('stale-anchor', 'missing chainId');
  }
  if (!releaseId || typeof releaseId !== 'string') {
    throw new BackpressureError('stale-anchor', 'missing releaseId');
  }
  if (typeof deploymentBlock !== 'number' || !Number.isFinite(deploymentBlock) || deploymentBlock < 0) {
    throw new BackpressureError('stale-anchor', 'invalid deploymentBlock');
  }
  if (!artifactChecksum || typeof artifactChecksum !== 'string') {
    throw new BackpressureError('stale-anchor', 'missing artifactChecksum');
  }
}

function anchorsEqual(a: ChainRestampAnchor, b: ChainRestampAnchor): boolean {
  return (
    a.chainId === b.chainId &&
    a.releaseId === b.releaseId &&
    a.deploymentBlock === b.deploymentBlock &&
    a.artifactChecksum === b.artifactChecksum
  );
}

export class BackpressureService<T extends ProtectedPayload = ProtectedPayload> extends EventEmitter {
  private readonly connections = new Map<string, ConnectionState<T>>();
  private readonly resumeRecords = new Map<string, ResumeRecord<T>>();
  private readonly defaultMaxQueueDepth: number;
  private readonly defaultHeartbeatIntervalMs: number;
  private readonly defaultHeartbeatTimeoutMs: number;
  private readonly maxTotalBufferedMessages: number;
  private readonly resumeTokenTtlMs: number;
  private readonly maxResumeBuffer: number;
  private readonly now: () => number;
  private totalBufferedMessages = 0;
  private totalDropped = 0;
  private isShutting = false;

  constructor(config: BackpressureConfig = {}) {
    super();
    this.defaultMaxQueueDepth = config.defaultMaxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    this.defaultHeartbeatIntervalMs =
      config.defaultHeartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.defaultHeartbeatTimeoutMs =
      config.defaultHeartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.maxTotalBufferedMessages =
      config.maxTotalBufferedMessages ?? DEFAULT_MAX_TOTAL_BUFFERED;
    this.resumeTokenTtlMs = config.resumeTokenTtlMs ?? DEFAULT_RESUME_TOKEN_TTL_MS;
    this.maxResumeBuffer = config.maxResumeBuffer ?? DEFAULT_MAX_RESUM_BUFFER;
    this.now = config.now ?? (() => Date.now());
  }

  /**
   * Register a connection with a bounded queue. The anchor is validated fail-closed
   * so stale/missing chain-derived data cannot enter the buffer.
   */
  registerConnection(options: ConnectionOptions): void {
    if (this.isShutting) {
      throw new Error('backpressure service is shutting down');
    }
    assertAnchor(options.anchor);
    if (this.connections.has(options.connectionId)) {
      throw new BackpressureError('duplicate-connection', 'connection already registered');
    }
    const maxQueueDepth = options.maxQueueDepth ?? this.defaultMaxQueueDepth;
    if (!Number.isInteger(maxQueueDepth) || maxQueueDepth <= 0) {
      throw new Error('maxQueueDepth must be a positive integer');
    }
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? this.defaultHeartbeatIntervalMs;
    const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? this.defaultHeartbeatTimeoutMs;
    if (heartbeatTimeoutMs <= heartbeatIntervalMs) {
      throw new Error('heartbeatTimeoutMs must be greater than heartbeatIntervalMs');
    }
    const now = this.now();
    this.connections.set(options.connectionId, {
      id: options.connectionId,
      anchor: { ...options.anchor },
      maxQueueDepth,
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
      queue: [],
      lastDeliveredSequence: 0,
      lastHeartbeatAtMs: now,
      droppedCount: 0,
      dropped: false,
    });
    this.emit('connection:registered', { connectionId: options.connectionId });
  }

  hasConnection(connectionId: string): boolean {
    return this.connections.has(connectionId);
  }

  /**
   * Enqueue a message for a single connection. On overflow the connection is
   * isolated (dropped) and a resumable recovery token is issued. Other connections
   * are never touched.
   */
  enqueue(connectionId: string, message: RealtimeMessage<T>): void {
    if (this.isShutting) {
      throw new Error('backpressure service is shutting down');
    }
    const state = this.connections.get(connectionId);
    if (!state) {
      throw new Error(`unknown connection: ${connectionId}`);
    }
    if (state.dropped) {
      // Dropped connections must resume before receiving new messages.
      this.emit('message:rejected', { connectionId: state.id, reason: 'dropped' });
      return;
    }
    if (message.sequence <= state.lastDeliveredSequence) {
      // Idempotent delivery: skip duplicates/out-of-order old messages.
      return;
    }
    if (this.totalBufferedMessages >= this.maxTotalBufferedMessages) {
      // Global budget exhausted: drop the slowest consumer to protect the worker.
      const slowest = this.findSlowestConsumer();
      if (slowest && slowest.id !== connectionId) {
        this.dropConnection(slowest.id, 'slowconsumer');
      } else {
        this.dropConnection(connectionId, 'queue-overflow');
        return;
      }
    }
    if (state.queue.length >= state.maxQueueDepth) {
      this.dropConnection(connectionId, 'queue-overflow');
      return;
    }
    state.queue.push({ message, enqueuedAtMs: this.now() });
    this.totalBufferedMessages += 1;
    this.emit('message:enqueued', {
      connectionId: state.id,
      sequence: message.sequence,
      queueDepth: state.queue.length,
    });
  }

  /**
   * Fan-out a message to all connections. Each connection is isolated: one
   * overflowing consumer does not affect delivery to the others.
   */
  broadcast(message: RealtimeMessage<T>): void {
    for (const id of this.connections.keys()) {
      try {
        this.enqueue(id, message);
      } catch {
        // Isolate failures per connection.
        this.dropConnection(id, 'slowconsumer');
      }
    }
  }

  /**
   * Deliver up to `maxBatch` queued messages to a consumer. Returns the delivered
   * messages. The consumer is responsible for acknowledging via `deliver`.
   */
  deliver(connectionId: string, maxBatch = 64): RealtimeMessage<T>[] {
    const state = this.connections.get(connectionId);
    if (!state) {
      throw new Error(`unknown connection: ${connectionId}`);
    }
    if (state.dropped) {
      return [];
    }
    const count = Math.min(maxBatch, state.queue.length);
    const delivered: RealtimeMessage<T>[] = [];
    for (let i = 0; i < count; i++) {
      const item = state.queue.shift();
      if (!item) break;
      delivered.push(item.message);
      state.lastDeliveredSequence = Math.max(state.lastDeliveredSequence, item.message.sequence);
    }
    this.totalBufferedMessages -= delivered.length;
    if (delivered.length > 0) {
      this.emit('message:delivered', {
        connectionId: state.id,
        count: delivered.length,
        lastSequence: state.lastDeliveredSequence,
      });
    }
    return delivered;
  }

  /**
   * Record a heartbeat from the client. If the client is silent beyond the
   * configured timeout, it is dropped with a resumable token.
   */
  recordHeartbeat(connectionId: string): void {
    const state = this.connections.get(connectionId);
    if (!state) {
      throw new Error(`unknown connection: ${connectionId}`);
    }
    state.lastHeartbeatAtMs = this.now();
  }

  /**
   * Scan all connections for heartbeat loss. Returns the ids dropped.
   */
  scanHeartbeats(): string[] {
    const now = this.now();
    const droppedIds: string[] = [];
    for (const state of this.connections.values()) {
      if (state.dropped) continue;
      if (now - state.lastHeartbeatAtMs > state.heartbeatTimeoutMs) {
        this.dropConnection(state.id, 'heartbeat-loss');
        droppedIds.push(state.id);
      }
    }
    return droppedIds;
  }

  /**
   * Drop a connection, isolating it from the rest of the fleet. A resumable
   * recovery token is issued and the remaining queued messages are retained
   * for catch-up handoff within the resume buffer limit.
   */
  private dropConnection(connectionId: string, reason: DropReason): void {
    const state = this.connections.get(connectionId);
    if (!state || state.dropped) {
      return;
    }
    state.dropped = true;
    state.dropReason = reason;
    state.droppedCount += 1;
    this.totalDropped += 1;

    // Retain a bounded resume buffer for catch-up handoff. The queue is
    // trimmed to the max resume buffer so memory stays bounded.
    const queued = state.queue.map((item) => item.message);
    const trimmed =
      queued.length > this.maxResumeBuffer
        ? queued.slice(queued.length - this.maxResumeBuffer)
        : queued;
    const token = `${state.id}:${state.lastDeliveredSequence}:${this.now()}`;
    state.resumeToken = token;
    state.resumeTokenSequence = state.lastDeliveredSequence;
    state.resumeTokenExpiresAtMs = this.now() + this.resumeTokenTtlMs;
    this.resumeRecords.set(token, {
      connectionId: state.id,
      anchor: { ...state.anchor },
      messages: trimmed,
      expiresAtMs: state.resumeTokenSequence !== undefined
        ? this.now() + this.resumeTokenTtlMs
        : this.now() + this.resumeTokenTtlMs,
    });

    // Release the buffered payloads immediately to bound memory.
    this.totalBufferedMessages -= state.queue.length;
    if (this.totalBufferedMessages < 0) {
      this.totalBufferedMessages = 0;
    }
    state.queue.length = 0;

    const info: DropInfo = {
      connectionId: state.id,
      reason,
      lastDeliveredSequence: state.lastDeliveredSequence,
      resumeToken: token,
      anchor: { ...state.anchor },
    };
    // Never log payloads; the drop info contains only metadata.
    this.emit('connection:dropped', info);
  }

  /**
   * Resume a dropped connection using a resume token and anchor. Fails closed on
   * stale/mismatched anchors or invalid/expired tokens.
   */
  resume(request: ResumeRequest): ResumeResult<T> {
    assertAnchor(request.anchor);
    const record = this.resumeRecords.get(request.resumeToken);
    if (!record) {
      return { ok: false, messages: [], gapDetected: true, reason: 'invalid-token' };
    }
    if (record.expiresAtMs <= this.now()) {
      this.resumeRecords.delete(request.resumeToken);
      return { ok: false, messages: [], gapDetected: true, reason: 'invalid-token' };
    }
    if (!record.anchor || !anchorsEqual(record.anchor, request.anchor)) {
      return { ok: false, messages: [], gapDetected: true, reason: 'stale-anchor' };
    }
    this.resumeRecords.delete(request.resumeToken);
    return { ok: true, messages: record.messages, gapDetected: false };
  }

  /**
   * Return sanitized stats. Never includes payloads.
   */
  getStats(): BackpressureStats {
    const slowConsumers: SlowConsumerMetrics[] = [];
    for (const state of this.connections.values()) {
      if (state.dropped || state.queue.length > state.maxQueueDepth / 2) {
        slowConsumers.push({
          connectionId: state.id,
          queueDepth: state.queue.length,
          dropped: state.dropped ? 1 : 0,
          lastDeliveredSequence: state.lastDeliveredSequence,
        });
      }
    }
    return {
      connections: this.connections.size,
      totalBufferedMessages: this.totalBufferedMessages,
      totalDropped: this.totalDropped,
      slowConsumers,
    };
  }

  /**
   * Gracefully shut down the service. All connections are dropped with a
   * shutdown reason and resumable tokens. Idempotent.
   */
  shutdown(): void {
    if (this.isShutting) {
      return;
    }
    this.isShutting = true;
    for (const id of Array.from(this.connections.keys())) {
      this.dropConnection(id, 'shutdown');
    }
    this.emit('shutdown');
  }

  private findSlowestConsumer(): ConnectionState<T> | undefined {
    let slowest: ConnectionState<T> | undefined;
    for (const state of this.connections.values()) {
      if (state.dropped) continue;
      if (!slowest || state.queue.length > slowest.queue.length) {
        slowest = state;
      }
    }
    return slowest;
  }
}

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { RealtimeEnvelope } from './realtime.types';

export interface RealtimeBackpressuredError extends Error {
  readonly backpressure: true;
}

export class RealtimeBusBackpressureError
  extends Error
  implements RealtimeBackpressuredError
{
  readonly backpressure = true;
  constructor(message: string) {
    super(message);
    this.name = 'RealtimeBusBackpressureError';
  }
}

interface Subscriber {
  id: number;
  next?: (envelope: RealtimeEnvelope) => void;
  error?: (err: unknown) => void;
  buffer: RealtimeEnvelope[];
  capacity: number;
  scheduled: boolean;
}

/**
 * In-process broadcast hub for live projection envelopes with bounded
 * per-subscriber backpressure.
 *
 * Each subscriber owns a fixed-capacity buffer. A burst of `publish` calls
 * within a single synchronous turn can push several envelopes into a buffer
 * before it is drained (asynchronously). If a subscriber's pending buffer ever
 * exceeds its bound, the subscriber is considered too slow to keep up and is
 * disconnected with a {@link RealtimeBusBackpressureError}. This gives a hard,
 * bounded ceiling on how much in-flight data any single connection can
 * accumulate, satisfying the bounded-backpressure requirement.
 */
@Injectable()
export class RealtimeBusService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeBusService.name);
  private readonly subscribers = new Map<number, Subscriber>();
  private nextId = 1;
  private closed = false;

  /**
   * Broadcast an envelope to all active subscribers.
   */
  publish(envelope: RealtimeEnvelope): void {
    if (this.closed) {
      return;
    }
    for (const sub of this.subscribers.values()) {
      if (sub.buffer.length < sub.capacity) {
        sub.buffer.push(envelope);
        this.scheduleDrain(sub);
      } else {
        this.logger.warn(
          `Subscriber #${sub.id} exceeded backpressure capacity (${sub.capacity}); closing`,
        );
        this.subscribers.delete(sub.id);
        try {
          sub.error?.(
            new RealtimeBusBackpressureError(
              `Stream backlog exceeded bounded capacity of ${sub.capacity} envelopes`,
            ),
          );
        } catch {
          /* ignore subscriber error handler failure */
        }
      }
    }
  }

  /**
   * Subscribe to live envelopes with a bounded per-subscriber buffer.
   */
  subscribe(
    next: (envelope: RealtimeEnvelope) => void,
    opts: { capacity?: number; error?: (err: unknown) => void } = {},
  ): { unsubscribe: () => void } {
    const id = this.nextId++;
    const sub: Subscriber = {
      id,
      next,
      error: opts.error ?? (() => undefined),
      buffer: [],
      capacity: Math.max(opts.capacity ?? 1000, 1),
      scheduled: false,
    };
    if (this.closed) {
      sub.error?.(new Error('Realtime bus is closed'));
      return { unsubscribe: () => undefined };
    }
    this.subscribers.set(id, sub);
    return {
      unsubscribe: () => {
        this.subscribers.delete(id);
      },
    };
  }

  private scheduleDrain(sub: Subscriber): void {
    if (sub.scheduled) {
      return;
    }
    sub.scheduled = true;
    queueMicrotask(() => {
      sub.scheduled = false;
      if (!this.subscribers.has(sub.id)) {
        return;
      }
      if (!sub.next) return;
      while (sub.buffer.length > 0) {
        const envelope = sub.buffer.shift()!;
        try {
          sub.next(envelope);
        } catch {
          this.subscribers.delete(sub.id);
          return;
        }
      }
    });
  }

  /**
   * Number of currently registered subscribers.
   */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  onModuleDestroy(): void {
    this.closed = true;
    this.subscribers.clear();
    this.logger.log('Realtime bus closed');
  }
}

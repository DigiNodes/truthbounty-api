import {
  RealtimeBusService,
  RealtimeBusBackpressureError,
} from './realtime-bus.service';
import { RealtimeEnvelopeType } from './realtime.enums';

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('RealtimeBusService', () => {
  let bus: RealtimeBusService;

  beforeEach(() => {
    bus = new RealtimeBusService();
  });

  afterEach(() => {
    bus.onModuleDestroy();
  });

  const env = (cursor: number, type = RealtimeEnvelopeType.EVENT) => ({
    cursor,
    type,
    timestamp: new Date().toISOString(),
  });

  it('delivers published envelopes to subscribers', async () => {
    const received: any[] = [];
    bus.subscribe((e) => received.push(e));
    bus.publish(env(1));
    bus.publish(env(2));
    await flush();
    expect(received.map((e) => e.cursor)).toEqual([1, 2]);
  });

  it('does not deliver after unsubscribe (including pending drain)', async () => {
    const received: any[] = [];
    const sub = bus.subscribe((e) => received.push(e));
    bus.publish(env(1));
    sub.unsubscribe();
    bus.publish(env(2));
    await flush();
    expect(received).toHaveLength(0);
  });

  it('isolates subscribers from one another', async () => {
    const a: any[] = [];
    const b: any[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));
    bus.publish(env(1));
    await flush();
    expect(a.map((e) => e.cursor)).toEqual([1]);
    expect(b.map((e) => e.cursor)).toEqual([1]);
  });

  it('enforces bounded backpressure by disconnecting an overflowing subscriber', async () => {
    const received: any[] = [];
    let error: unknown;
    // capacity 1: a second pending envelope pushed before the microtask drain
    // overflows the bounded buffer.
    bus.subscribe(
      (e) => {
        received.push(e);
      },
      { capacity: 1, error: (err) => (error = err) },
    );
    bus.publish(env(1));
    bus.publish(env(2));
    expect(error).toBeInstanceOf(RealtimeBusBackpressureError);
    expect((error as RealtimeBusBackpressureError).backpressure).toBe(true);
    await flush();
  });

  it('keeps buffered envelopes when they fit within capacity', async () => {
    const received: any[] = [];
    bus.subscribe((e) => received.push(e), { capacity: 10 });
    bus.publish(env(1));
    bus.publish(env(2));
    await flush();
    expect(received.map((e) => e.cursor)).toEqual([1, 2]);
  });

  it('tracks subscriber count', () => {
    expect(bus.subscriberCount()).toBe(0);
    bus.subscribe(() => undefined);
    expect(bus.subscriberCount()).toBe(1);
  });

  it('does not publish after destroy', async () => {
    const received: any[] = [];
    bus.subscribe((e) => received.push(e));
    bus.onModuleDestroy();
    bus.publish(env(1));
    await flush();
    expect(received).toHaveLength(0);
  });
});

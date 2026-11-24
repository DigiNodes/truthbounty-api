import { assertSafeChaosEnvironment, assertSafeTargetUrl } from './fault-guard';
import { DeterministicPRNG } from './prng';

export interface BaseAdapterState {
  healthy: boolean;
  mode: 'healthy' | 'fail' | 'slow' | 'corrupt';
  latencyMs: number;
  corruptionType?: string;
  failureMessage?: string;
  lastFaultAt?: string;
  operationsCount: number;
  failuresCount: number;
}

export abstract class BaseDependencyFaultAdapter {
  protected state: BaseAdapterState = {
    healthy: true,
    mode: 'healthy',
    latencyMs: 0,
    operationsCount: 0,
    failuresCount: 0,
  };

  constructor(
    public readonly name: string,
    public readonly targetUrl?: string,
    protected readonly prng: DeterministicPRNG = new DeterministicPRNG(),
  ) {
    // Fail closed if target is production
    assertSafeChaosEnvironment(targetUrl);
  }

  getState(): Readonly<BaseAdapterState> {
    return { ...this.state };
  }

  fail(reason = 'Simulated dependency failure'): void {
    assertSafeChaosEnvironment(this.targetUrl);
    this.state.healthy = false;
    this.state.mode = 'fail';
    this.state.failureMessage = reason;
    this.state.lastFaultAt = new Date().toISOString();
  }

  slow(latencyMs: number): void {
    assertSafeChaosEnvironment(this.targetUrl);
    this.state.healthy = true;
    this.state.mode = 'slow';
    this.state.latencyMs = latencyMs;
    this.state.lastFaultAt = new Date().toISOString();
  }

  corrupt(corruptionType = 'malformed-payload'): void {
    assertSafeChaosEnvironment(this.targetUrl);
    this.state.healthy = false;
    this.state.mode = 'corrupt';
    this.state.corruptionType = corruptionType;
    this.state.lastFaultAt = new Date().toISOString();
  }

  recover(): void {
    this.state.healthy = true;
    this.state.mode = 'healthy';
    this.state.latencyMs = 0;
    this.state.corruptionType = undefined;
    this.state.failureMessage = undefined;
  }

  protected async applyFaultSimulation(): Promise<void> {
    this.state.operationsCount++;

    if (this.state.mode === 'fail') {
      this.state.failuresCount++;
      throw new Error(`[CHAOS FAULT: ${this.name}] ${this.state.failureMessage || 'Dependency unavailable'}`);
    }

    if (this.state.mode === 'slow' && this.state.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.state.latencyMs));
    }
  }
}

/**
 * 1. Database Fault Adapter (PostgreSQL / TypeORM / Prisma)
 */
export class DatabaseFaultAdapter extends BaseDependencyFaultAdapter {
  constructor(targetUrl = 'postgres://postgres:postgres@localhost:5432/truthbounty_test', prng?: DeterministicPRNG) {
    super('Database', targetUrl, prng);
  }

  async executeQuery<T>(queryFn: () => Promise<T>): Promise<T> {
    await this.applyFaultSimulation();
    if (this.state.mode === 'corrupt') {
      this.state.failuresCount++;
      throw new Error('[CHAOS FAULT: Database] Serialization failure / corrupted transaction state (SQLSTATE 40P01)');
    }
    return queryFn();
  }
}

/**
 * 2. Redis Fault Adapter (Cache, Lock, Outbox idempotency)
 */
export class RedisFaultAdapter extends BaseDependencyFaultAdapter {
  private inMemoryStore = new Map<string, string>();

  constructor(targetUrl = 'redis://localhost:6379/1', prng?: DeterministicPRNG) {
    super('Redis', targetUrl, prng);
  }

  async get(key: string): Promise<string | null> {
    await this.applyFaultSimulation();
    if (this.state.mode === 'corrupt') {
      return '{"corrupted":true, "invalid_json":';
    }
    return this.inMemoryStore.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<'OK'> {
    await this.applyFaultSimulation();
    if (this.state.mode === 'corrupt') {
      throw new Error('[CHAOS FAULT: Redis] WRONGTYPE Operation against a key holding the wrong kind of value');
    }
    this.inMemoryStore.set(key, value);
    return 'OK';
  }
}

/**
 * 3. RPC Fault Adapter (Optimism Sepolia EVM Provider)
 */
export class RpcFaultAdapter extends BaseDependencyFaultAdapter {
  private chainId = 11155420; // Optimism Sepolia

  constructor(targetUrl = 'https://sepolia.optimism.io', prng?: DeterministicPRNG) {
    super('RPC', targetUrl, prng);
  }

  async getBlockNumber(actualBlock: number): Promise<number> {
    await this.applyFaultSimulation();
    if (this.state.mode === 'corrupt') {
      // Divergent/stale head
      return Math.max(0, actualBlock - 50);
    }
    return actualBlock;
  }

  async getLogs(logsFn: () => Promise<unknown[]>): Promise<unknown[]> {
    await this.applyFaultSimulation();
    if (this.state.mode === 'corrupt') {
      // Return logs with corrupted transaction hash or mismatched topic
      const logs = await logsFn();
      return logs.map((log: any) => ({
        ...log,
        blockHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        corrupted: true,
      }));
    }
    return logsFn();
  }
}

/**
 * 4. IPFS Fault Adapter (Evidence gateway / Pinata)
 */
export class IpfsFaultAdapter extends BaseDependencyFaultAdapter {
  constructor(targetUrl = 'http://localhost:5001/api/v0', prng?: DeterministicPRNG) {
    super('IPFS', targetUrl, prng);
  }

  async fetchContent(cid: string, expectedBuffer: Buffer): Promise<Buffer> {
    await this.applyFaultSimulation();
    if (this.state.mode === 'corrupt') {
      // Return tampered buffer that intentionally violates CID checksum
      return Buffer.from(`tampered-evidence-content-${this.prng.nextInt(100, 999)}`);
    }
    return expectedBuffer;
  }
}

/**
 * 5. Provider Fault Adapter (External AI / Oracle)
 */
export class ProviderFaultAdapter extends BaseDependencyFaultAdapter {
  constructor(targetUrl = 'https://api-sandbox.truthbounty.test/v1', prng?: DeterministicPRNG) {
    super('Provider', targetUrl, prng);
  }

  async invoke<T>(payload: unknown, fallbackFn: () => Promise<T>): Promise<T> {
    await this.applyFaultSimulation();
    if (this.state.mode === 'corrupt') {
      throw new Error('[CHAOS FAULT: Provider] Malformed model completion schema / JSON parsing error');
    }
    return fallbackFn();
  }
}

/**
 * 6. Queue Fault Adapter (BullMQ / Transactional Outbox)
 */
export class QueueFaultAdapter extends BaseDependencyFaultAdapter {
  private duplicateRate = 0.5;

  constructor(targetUrl = 'redis://localhost:6379/2', prng?: DeterministicPRNG) {
    super('Queue', targetUrl, prng);
  }

  async dispatch<T>(jobId: string, payload: T, handler: (job: T) => Promise<void>): Promise<number> {
    await this.applyFaultSimulation();
    let deliveries = 1;

    if (this.state.mode === 'corrupt') {
      // Duplicate delivery simulation
      deliveries = 2;
      await handler(payload);
      await handler(payload);
      return deliveries;
    }

    await handler(payload);
    return deliveries;
  }
}

/**
 * 7. Stream Fault Adapter (WebSocket / Server-Sent Events)
 */
export class StreamFaultAdapter extends BaseDependencyFaultAdapter {
  constructor(targetUrl = 'ws://localhost:3000/events', prng?: DeterministicPRNG) {
    super('Stream', targetUrl, prng);
  }

  async emitEvent(channel: string, event: unknown, onDeliver: (e: unknown) => void): Promise<void> {
    await this.applyFaultSimulation();
    if (this.state.mode === 'corrupt') {
      // Corrupt event format
      onDeliver({ invalid_frame: true, raw: '0xFF_BROKEN_FRAME' });
      return;
    }
    onDeliver(event);
  }
}

/**
 * 8. Clock Fault Adapter (Time skew, leaps, freeze)
 */
export class ClockFaultAdapter extends BaseDependencyFaultAdapter {
  private timeOffsetMs = 0;
  private frozenTime: number | null = null;

  constructor(prng?: DeterministicPRNG) {
    super('Clock', 'mock://system-clock', prng);
  }

  now(): number {
    this.state.operationsCount++;
    if (this.frozenTime !== null) {
      return this.frozenTime;
    }
    if (this.state.mode === 'fail') {
      // Monotonic clock jump backwards
      return Date.now() - 3600_000;
    }
    if (this.state.mode === 'corrupt') {
      // Leap forward into the future
      return Date.now() + 86400_000 * 30;
    }
    return Date.now() + this.timeOffsetMs;
  }

  freeze(atTimestamp = Date.now()): void {
    assertSafeChaosEnvironment(this.targetUrl);
    this.frozenTime = atTimestamp;
    this.state.healthy = false;
    this.state.mode = 'fail';
  }

  unfreeze(): void {
    this.frozenTime = null;
    this.recover();
  }

  override recover(): void {
    super.recover();
    this.timeOffsetMs = 0;
    this.frozenTime = null;
  }

  skew(offsetMs: number): void {
    assertSafeChaosEnvironment(this.targetUrl);
    this.timeOffsetMs = offsetMs;
    this.state.healthy = true;
    this.state.mode = 'slow';
  }
}

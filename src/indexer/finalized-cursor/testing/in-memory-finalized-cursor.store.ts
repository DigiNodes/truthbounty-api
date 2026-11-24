import {
  FinalizedCursorStore,
  FinalizedCursorTransaction,
} from '../finalized-cursor.store';
import {
  CanonicalEvent,
  ChainHeads,
  FinalizedCursorRecord,
} from '../finalized-cursor.types';

/** Transaction handle exposed to projection effects in tests. */
export interface InMemoryProjectionHandle {
  /** Staged projection writes; committed only if the transaction commits. */
  write(event: CanonicalEvent): void;
}

type FaultPoint =
  'lockCursor' | 'insertCursor' | 'updateHeads' | 'advanceWatermark' | 'commit';

const eventKey = (e: CanonicalEvent) =>
  `${e.chainId}:${e.releaseId}:${e.blockNumber}:${e.transactionHash}:${e.logIndex}`;

/**
 * Deterministic, transactional in-memory store for tests. It survives
 * "restarts" (new service instances share it), serializes transactions like
 * a row lock, and can inject a crash at any step to prove atomicity.
 */
export class InMemoryFinalizedCursorStore implements FinalizedCursorStore<InMemoryProjectionHandle> {
  private readonly cursors = new Map<string, FinalizedCursorRecord>();
  /** Committed projection effects: event key -> times applied. */
  readonly projection = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private fault: FaultPoint | null = null;

  /** Crash the next transaction that reaches `point`. */
  failNext(point: FaultPoint): void {
    this.fault = point;
  }

  async read(
    chainId: number,
    releaseId: string,
  ): Promise<FinalizedCursorRecord | null> {
    // Like a committed read: wait for in-flight transactions to finish.
    await this.queue;
    const row = this.cursors.get(`${chainId}:${releaseId}`);
    return row ? { ...row } : null;
  }

  /** Test helper: overwrite a committed row (e.g. to simulate a foreign release). */
  seed(record: FinalizedCursorRecord): void {
    this.cursors.set(`${record.chainId}:${record.releaseId}`, { ...record });
  }

  transaction<T>(
    fn: (
      tx: FinalizedCursorTransaction<InMemoryProjectionHandle>,
    ) => Promise<T>,
  ): Promise<T> {
    const run = this.queue.then(() => this.runTransaction(fn));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runTransaction<T>(
    fn: (
      tx: FinalizedCursorTransaction<InMemoryProjectionHandle>,
    ) => Promise<T>,
  ): Promise<T> {
    const stagedCursors = new Map(
      [...this.cursors].map(([k, v]) => [k, { ...v }]),
    );
    const stagedEffects: CanonicalEvent[] = [];
    // Async so each step yields like a real database round-trip.
    const trip = async (point: FaultPoint) => {
      await Promise.resolve();
      if (this.fault === point) {
        this.fault = null;
        throw new Error(`simulated crash at ${point}`);
      }
    };

    const tx: FinalizedCursorTransaction<InMemoryProjectionHandle> = {
      handle: { write: (event) => stagedEffects.push(event) },
      lockCursor: async (chainId, releaseId) => {
        await trip('lockCursor');
        const row = stagedCursors.get(`${chainId}:${releaseId}`);
        return row ? { ...row } : null;
      },
      insertCursor: async (record) => {
        await trip('insertCursor');
        const key = `${record.chainId}:${record.releaseId}`;
        if (!stagedCursors.has(key)) stagedCursors.set(key, { ...record });
      },
      updateHeads: async (chainId, releaseId, heads: ChainHeads) => {
        await trip('updateHeads');
        const row = stagedCursors.get(`${chainId}:${releaseId}`);
        if (!row) return;
        row.observedHead = heads.observedHead;
        row.safeHead = heads.safeHead;
        row.finalizedHead = heads.finalizedHead;
        row.headsObservedAt = heads.observedAt;
      },
      advanceWatermark: async (
        chainId,
        releaseId,
        expected,
        next,
        hash,
        at,
      ) => {
        await trip('advanceWatermark');
        const row = stagedCursors.get(`${chainId}:${releaseId}`);
        if (!row || row.indexedWatermark !== expected) return false;
        row.indexedWatermark = next;
        row.watermarkBlockHash = hash;
        row.watermarkUpdatedAt = at;
        return true;
      },
    };

    const result = await fn(tx);
    await trip('commit');
    // Commit: publish staged cursor rows and effects together.
    this.cursors.clear();
    for (const [k, v] of stagedCursors) this.cursors.set(k, v);
    for (const event of stagedEffects) {
      const key = eventKey(event);
      this.projection.set(key, (this.projection.get(key) ?? 0) + 1);
    }
    return result;
  }
}

import { ChainHeads, FinalizedCursorRecord } from './finalized-cursor.types';

export const FINALIZED_CURSOR_STORE = Symbol('FINALIZED_CURSOR_STORE');

/**
 * Operations available inside one cursor transaction. `handle` is the
 * underlying transactional handle (a TypeORM QueryRunner in production) and is
 * passed to projection-effect callbacks so effects commit or roll back
 * together with the watermark.
 */
export interface FinalizedCursorTransaction<THandle = unknown> {
  readonly handle: THandle;
  /** Reads the cursor row and locks it until the transaction ends. */
  lockCursor(
    chainId: number,
    releaseId: string,
  ): Promise<FinalizedCursorRecord | null>;
  insertCursor(record: FinalizedCursorRecord): Promise<void>;
  updateHeads(
    chainId: number,
    releaseId: string,
    heads: ChainHeads,
  ): Promise<void>;
  /**
   * Compare-and-set: advances the watermark only if it still equals
   * `expectedWatermark`. Returns false when another writer moved it.
   */
  advanceWatermark(
    chainId: number,
    releaseId: string,
    expectedWatermark: bigint,
    nextWatermark: bigint,
    blockHash: string,
    at: Date,
  ): Promise<boolean>;
}

export interface FinalizedCursorStore<THandle = unknown> {
  /** Runs `fn` atomically: all writes commit together or none do. */
  transaction<T>(
    fn: (tx: FinalizedCursorTransaction<THandle>) => Promise<T>,
  ): Promise<T>;
  read(
    chainId: number,
    releaseId: string,
  ): Promise<FinalizedCursorRecord | null>;
}

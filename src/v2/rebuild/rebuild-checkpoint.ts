import { createHash } from 'crypto';

/**
 * The deterministic part of a projection rebuild.
 *
 * ## What makes a rebuild report reproducible
 *
 * `RebuildCheckpoint` contains **no wall-clock time, no duration, no run id,
 * and no host or environment detail**. It is a pure function of:
 *
 *   (chainId, deploymentBlock, the ordered set of canonical events in range)
 *
 * Given the same deployment block and the same canonical event log, two
 * rebuilds — on different machines, on different days, resumed differently, in
 * different batch sizes — produce byte-identical checkpoints. That is the whole
 * point: an operator can diff two reports and any difference is a *real*
 * difference in the projection, not noise.
 *
 * Anything non-deterministic (timestamps, duration, host) lives in
 * `ProjectionRebuildRun`, the database row, and is explicitly excluded from
 * this structure.
 */

export type RebuildStatus = 'running' | 'completed' | 'aborted' | 'failed';

/** Seed for the rolling digest. A constant, so the fold is reproducible. */
export const REBUILD_DIGEST_SEED = 'truthbounty:v2:projection-rebuild:v1';

export interface ProjectionRebuildCounter {
  /** Events this projector consumed from the canonical log. */
  eventsConsumed: number;
  /** Events this projector applied to its read model. */
  eventsApplied: number;
  /** Events this projector deliberately did not apply (duplicate/no-op). */
  eventsSkipped: number;
  /** Events this projector refused and recorded as an indexing anomaly. */
  anomalies: number;
  /** Rows present in this projector's table when the drain finished. */
  rowsInTable: number;
}

export interface RebuildCheckpoint {
  chainId: number;
  /** The block the rebuild started from, as configured. */
  deploymentBlock: string;
  /** Where this (possibly resumed) run picked up. */
  fromBlock: string;
  /** Highest canonical block fully drained. Null until the drain completes. */
  toBlock: string | null;
  /** Log index cursor at `toBlock`, for an exact resume point. */
  logIndex: number;
  batchesProcessed: number;
  /** Canonical events folded into `inputDigest` for this run. */
  eventsConsumed: number;
  eventsApplied: number;
  eventsSkipped: number;
  anomalies: number;
  /**
   * Canonical events in the drained range that no registered projection claims.
   * A non-zero value means the registry's `eventNames` are out of date — a new
   * projector exists in the code but not in the rebuild registry, so the
   * rebuilt read model would silently be missing a projection.
   */
  unclaimedEvents: number;
  /**
   * Rolling SHA-256 over the ordered identities of every canonical event
   * consumed. Order-dependent, so a reordering of the log is detectable.
   */
  inputDigest: string;
  perProjection: Record<string, ProjectionRebuildCounter>;
  /**
   * True only when the drain ran to completion, produced no anomalies, and
   * wrote no partial state. This is the precondition the cutover procedure
   * checks; the rebuild pipeline itself never performs a cutover.
   */
  safeToCutover: boolean;
  complete: boolean;
}

/** One canonical event's stable identity, in the order it was consumed. */
export function canonicalEventIdentity(event: {
  chainId: number;
  txHash: string;
  logIndex: number;
  eventName: string;
}): string {
  return `${event.chainId}:${event.txHash}:${event.logIndex}:${event.eventName}`;
}

/**
 * Fold a batch of event identities into the rolling digest.
 *
 * A left fold, not a set hash, so:
 *  - it is order-dependent (a reordered log yields a different digest);
 *  - it is resumable, because the accumulator is the only state carried
 *    across a checkpoint boundary.
 *
 * Folding `[]` returns the previous digest unchanged, so an empty batch cannot
 * perturb the result.
 */
export function foldDigest(previous: string, identities: string[]): string {
  if (identities.length === 0) return previous;
  const hash = createHash('sha256');
  hash.update(previous);
  for (const identity of identities) {
    hash.update('\n');
    hash.update(identity);
  }
  return hash.digest('hex');
}

/** The digest a rebuild produces before consuming anything. */
export function initialDigest(): string {
  return foldDigest(REBUILD_DIGEST_SEED, []);
}

export function emptyCounter(): ProjectionRebuildCounter {
  return {
    eventsConsumed: 0,
    eventsApplied: 0,
    eventsSkipped: 0,
    anomalies: 0,
    rowsInTable: 0,
  };
}

/**
 * Serialise a checkpoint with **sorted keys** so that two structurally equal
 * checkpoints serialise to identical bytes. `JSON.stringify` preserves
 * insertion order, which would make the output depend on the order projections
 * happened to be registered in — a real source of spurious diffs.
 */
export function serializeCheckpoint(checkpoint: RebuildCheckpoint): string {
  return JSON.stringify(sortKeys(checkpoint), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = sortKeys(source[key]);
  }
  return sorted;
}

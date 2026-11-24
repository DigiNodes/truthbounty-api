import { createHash } from 'crypto';

export interface RecoveryObservation {
  completed: boolean;
  duplicateEffects: number;
  committedCheckpoint?: number;
  errorMessage?: string;
  retryCount?: number;
  finalizedFromUntrustedInput?: boolean;
  gapsDetected?: number;
  falseFreshnessDetected?: boolean;
  projectionDigest?: string;
  canonicalDigest?: string;
}

export interface FreshnessCheckOptions {
  updatedAt: number;
  headTimestamp: number;
  maxAllowedLagMs: number;
  isDegraded: boolean;
  isStaleServedAsFresh: boolean;
}

/**
 * Asserts retry limits and ensures NO sensitive credentials appear in error outputs.
 */
export function assertBoundedFailure(
  observation: RecoveryObservation,
  maxRetries: number,
): void {
  if ((observation.retryCount ?? 0) > maxRetries) {
    throw new Error(`Retry budget exceeded: ${observation.retryCount}`);
  }

  if (
    observation.errorMessage?.match(/secret|token|password|private[_ -]?key|bearer/i)
  ) {
    throw new Error('Sensitive material appeared in an error observation');
  }
}

/**
 * Asserts exactly 0 duplicate side effects occurred during or after recovery.
 */
export function assertIdempotentRecovery(
  observation: RecoveryObservation,
): void {
  if (observation.duplicateEffects !== 0) {
    throw new Error(
      `Recovery produced ${observation.duplicateEffects} duplicate effects`,
    );
  }
}

/**
 * Asserts system failed closed against untrusted or unfinalized chain inputs.
 */
export function assertFailClosed(observation: RecoveryObservation): void {
  if (observation.finalizedFromUntrustedInput) {
    throw new Error('Untrusted chain input was treated as finalized');
  }
}

/**
 * Asserts that a sequence of block numbers, nonces, or outbox IDs has NO missing entries (no gaps).
 */
export function assertNoGap(
  items: number[] | { start: number; end: number; received: number[] },
): void {
  if (Array.isArray(items)) {
    if (items.length <= 1) return;
    const sorted = [...items].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const diff = sorted[i] - sorted[i - 1];
      if (diff > 1) {
        throw new Error(`Sequence gap detected: missing entries between ${sorted[i - 1]} and ${sorted[i]}`);
      }
    }
    return;
  }

  const { start, end, received } = items;
  const set = new Set(received);
  const missing: number[] = [];
  for (let cursor = start; cursor <= end; cursor++) {
    if (!set.has(cursor)) {
      missing.push(cursor);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Sequence gap detected between ${start} and ${end}: missing ${missing.length} item(s) [${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}]`,
    );
  }
}

/**
 * Asserts that a collection of items contains NO duplicates.
 */
export function assertNoDuplicate<T>(
  items: T[],
  keyExtractor?: (item: T) => string | number,
): void {
  const seen = new Set<string | number>();
  const duplicates: Array<string | number> = [];

  for (const item of items) {
    const key = keyExtractor ? keyExtractor(item) : (item as unknown as string | number);
    if (seen.has(key)) {
      duplicates.push(key);
    } else {
      seen.add(key);
    }
  }

  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate invariant violated: found ${duplicates.length} duplicate item(s) [${duplicates.slice(0, 5).join(', ')}]`,
    );
  }
}

/**
 * Asserts that stale or degraded projections explicitly flag degraded status
 * and NEVER serve stale data under the guise of fresh canonical state.
 */
export function assertNoFalseFreshness(options: FreshnessCheckOptions): void {
  const currentLagMs = options.headTimestamp - options.updatedAt;

  if (options.isStaleServedAsFresh) {
    throw new Error('False freshness invariant violated: stale state served without degradation flag');
  }

  if (currentLagMs > options.maxAllowedLagMs && !options.isDegraded) {
    throw new Error(
      `False freshness invariant violated: lag (${currentLagMs}ms) exceeds budget (${options.maxAllowedLagMs}ms) but isDegraded=false`,
    );
  }
}

/**
 * Asserts that replayed state digest equals canonical contract digest byte-for-byte.
 */
export function assertDigestParity(actualDigest: string, expectedDigest: string): void {
  if (!actualDigest || !expectedDigest) {
    throw new Error('Cannot assert digest parity on empty digests');
  }
  if (actualDigest.toLowerCase() !== expectedDigest.toLowerCase()) {
    throw new Error(
      `Projection digest mismatch: actual=${actualDigest.slice(0, 16)}... expected=${expectedDigest.slice(0, 16)}...`,
    );
  }
}

/**
 * Calculates SHA-256 digest of normalized projection state.
 */
export function computeStateDigest(state: unknown): string {
  const serialized = JSON.stringify(state, Object.keys(state as any || {}).sort());
  return createHash('sha256').update(serialized).digest('hex');
}

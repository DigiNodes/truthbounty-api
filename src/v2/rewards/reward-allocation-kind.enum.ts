/**
 * The five reward-allocation beneficiary classes defined by V2-BE-017.
 *
 * These are *labels the protocol itself emits*, not a taxonomy this service
 * invented: the value written to {@link AllocationKind} is read verbatim from
 * the `kind` field of a canonical `RewardAllocated` event, and an event whose
 * `kind` is not one of these five is rejected and recorded as an indexing
 * anomaly rather than being coerced into a bucket.
 *
 * - SUBMITTER  — the party that submitted the claim evidence
 * - VERIFIER   — a participant whose verification position was rewarded
 * - CHALLENGER — the party that raised a dispute whose position was rewarded
 * - TREASURY   — the protocol treasury sink (beneficiary is not an EOA)
 * - REFUND     — a returned bond/stake refund to a party that lost nothing
 */
export enum AllocationKind {
  SUBMITTER = 'submitter',
  VERIFIER = 'verifier',
  CHALLENGER = 'challenger',
  TREASURY = 'treasury',
  REFUND = 'refund',
}

export const ALLOCATION_KINDS: readonly AllocationKind[] = Object.freeze([
  AllocationKind.SUBMITTER,
  AllocationKind.VERIFIER,
  AllocationKind.CHALLENGER,
  AllocationKind.TREASURY,
  AllocationKind.REFUND,
]);

/**
 * Narrow an arbitrary payload value to a known {@link AllocationKind}.
 * Returns `null` for anything unrecognised — callers must treat `null` as
 * "reject and record an anomaly", never as a default.
 */
export function parseAllocationKind(raw: string | null): AllocationKind | null {
  if (raw === null) return null;
  const normalized = raw.trim().toLowerCase();
  for (const kind of ALLOCATION_KINDS) {
    if (kind === normalized) return kind;
  }
  return null;
}

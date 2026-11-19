export type ChainId = string;
export type ReleaseId = string;
export type DisputeId = string;

/**
 * Provenance binding for any projected value. Every value that is
 * derived from chain state must carry this provenance so that consumers
 * can verify chain/release isolation and finality gating.
 */
export interface Provenance {
  readonly chainId: ChainId;
  readonly releaseId: ReleaseId;
  /** Canonical event identifier (e.g. tx hash + log index). */
  readonly eventId: string;
  /** Block height of the canonical event. */
  readonly blockHeight: number;
  /** Block hash of the canonical event. */
  readonly blockHash: string;
  /** Finality checkpoint height at which this value was considered final. */
  readonly finalityCheckpoint: number;
  /** Timestamp (ms) of the canonical event. */
  readonly eventTimestamp: number;
}

export type DisputeStatus =
  | 'open'
  | 'appealed'
  | 'resolved'
  | 'closed';

export type AppealStatus = 'open' | 'expired' | 'appealed';

export type SettlementStatus = 'provisional' | 'finalized';

export type BondDisposition = 'returned' | 'slashed' | 'transferred';

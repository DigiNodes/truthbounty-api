/**
 * A single observed block header: enough to detect a reorg (by comparing
 * `hash` at a given `height` against what was previously stored) and to
 * walk ancestry back to a common ancestor via `parentHash`.
 *
 * Optimism/EVM semantics only: chainId + 0x-hex block hashes. No
 * Stellar/Soroban/Freighter concepts belong here.
 */
export interface BlockHeader {
  height: bigint;
  hash: string;
  parentHash: string;
}

export type ConfirmationLevel = 'observed' | 'safe' | 'finalized';

/**
 * Durable cursor state scoped by chain, source, release and projection, with
 * the deployment floor and artifact checksum that provenance checks must match.
 */
export interface CursorState {
  chainId: number;
  source: string;
  releaseId: string;
  projectionId: string;
  deploymentBlock: bigint;
  artifactChecksum: string;
  processedHeight: bigint;
  processedHash: string;
  safeHeight: bigint;
  safeHash: string;
  finalizedHeight: bigint;
  finalizedHash: string;
  version: number;
  updatedAt: Date;
}

/**
 * Result of walking stored ancestry against the chain's current canonical
 * view to find the common ancestor after a suspected reorg.
 */
export type CommonAncestorResult =
  | { found: true; ancestor: BlockHeader; orphanedHeights: bigint[] }
  | { found: false };

/**
 * Data state classification for all projected V2 entities, per the requirement
 * to distinguish observed, safe, and finalized data:
 *
 * - OBSERVED: The event was seen but has not reached the safe block height
 * - SAFE: The block containing the event is below the chain's lastSafeBlock
 * - FINALIZED: The block containing the event is below the chain's lastFinalizedBlock
 */
export enum DataState {
  OBSERVED = 'observed',
  SAFE = 'safe',
  FINALIZED = 'finalized',
}
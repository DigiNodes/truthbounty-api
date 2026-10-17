export enum ReorgRecoveryStatus {
  HEALTHY = 'HEALTHY',
  ROLLING_BACK = 'ROLLING_BACK',
  REPLAYING = 'REPLAYING',
  RECOVERED = 'RECOVERED',
  STOPPED_DEEP_REORG = 'STOPPED_DEEP_REORG',
  STOPPED_AMBIGUOUS = 'STOPPED_AMBIGUOUS',
}

export interface ReorgRecoveryStatusSnapshot {
  status: ReorgRecoveryStatus;
  chainId: number;
  detectedAt: Date | null;
  recoveredAt: Date | null;
  /** The block hash where the fork occurred */
  forkBlockHash: string | null;
  forkBlockNumber: string | null;
  /** How many blocks deep the reorg was */
  reorgDepth: number | null;
  reason: string | null;
}

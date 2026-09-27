import { RawLog } from './canonical-event.interface';

export interface IV2Projector {
  readonly projectorName?: string;
  processNewEvents(batchSize?: number): Promise<{
    processed: number;
    applied: number;
    anomalies?: number;
    duplicates?: number;
  }>;
}

export interface AffectedReadModels {
  evidenceVersionsRemoved: number;
  evidenceUpdated: number;
  evidenceRemoved: number;
  verificationRoundsRemoved: number;
  participantPositionsRemoved: number;
  disputesReverted: number;
  disputesRemoved: number;
  anomaliesRemoved: number;
}

export interface ReorgRollbackResult {
  chainId: number;
  rollbackToBlock: string;
  purgedEventsCount: number;
  purgedQuarantinesCount: number;
  checkpointsUpdated: number;
  rewoundCursors: string[];
  affectedReadModels: AffectedReadModels;
}

export interface CanonicalReapplicationResult {
  logsProcessed: number;
  ingestedCount: number;
  duplicateCount: number;
  quarantinedCount: number;
  projectorSummaries: Record<
    string,
    {
      processed: number;
      applied: number;
      anomalies?: number;
      duplicates?: number;
    }
  >;
}

export interface ReorgExecutionResult {
  rollback: ReorgRollbackResult;
  reapplication: CanonicalReapplicationResult;
}

export interface ReorgOptions {
  chainId: number;
  rollbackToBlock: bigint | string | number;
  contractAddress?: string;
  newLogs?: RawLog[];
  batchSize?: number;
}

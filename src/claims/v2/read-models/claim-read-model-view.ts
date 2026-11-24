import { DataState } from '../../../v2/common/data-state.enum';
import { ClaimReadModel } from '../../entities/claim-read-model.entity';
import {
  ClaimDeadlines,
  ClaimReadModelItem,
  ClaimReadModelPhase,
  EvidenceAvailability,
  ReleaseProvenance,
  TERMINAL_CLAIM_STATES,
} from './claim-read-model.types';

export interface ClaimItemInputs {
  provenance: ReleaseProvenance;
  /** Chain finality of the claim's last applied event. */
  dataState: DataState;
  evidence: EvidenceAvailability;
  deadlines: ClaimDeadlines;
}

export function isTerminalClaimState(state: string): boolean {
  return TERMINAL_CLAIM_STATES.includes(state);
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Derive the published phase for a projected claim.
 *
 * A claim is only `finalized` when its lifecycle reached a terminal state AND
 * the block carrying that state is chain-finalized. Anything else — including
 * a terminal state that has not yet reached finality — is `provisional`, so
 * provisional data is never presented as final.
 */
export function deriveClaimPhase(
  state: string,
  dataState: DataState,
): ClaimReadModelPhase {
  return isTerminalClaimState(state) && dataState === DataState.FINALIZED
    ? 'finalized'
    : 'provisional';
}

/**
 * Pure projection of a canonical claim read-model row into the published,
 * phase-separated item. No I/O, no clock, no inference left to the frontend.
 */
export function toClaimReadModelItem(
  row: ClaimReadModel,
  inputs: ClaimItemInputs,
): ClaimReadModelItem {
  const phase = deriveClaimPhase(row.state, inputs.dataState);
  const settledAt = toIso(row.settledAt);

  return {
    claimId: row.claimId,
    chainId: inputs.provenance.chainId,
    state: row.state,
    dataState: inputs.dataState,
    phase,
    lastEvent: {
      blockNumber: String(row.blockNumber),
      eventIndex: row.eventIndex,
      txHash: row.eventTxHash,
      at: toIso(row.stateChangedAt) ?? new Date(0).toISOString(),
    },
    deadlines: {
      verification: inputs.deadlines.verification,
      appeal: inputs.deadlines.appeal,
      settledAt,
    },
    evidence: {
      state: inputs.evidence.state,
      activeCount: inputs.evidence.activeCount,
      finalizedCount: inputs.evidence.finalizedCount,
      latestBlockNumber: inputs.evidence.latestBlockNumber,
    },
    outcome: {
      phase,
      provisional:
        phase === 'finalized' ? null : { state: row.state, settledAt },
      final: phase === 'finalized' ? { state: row.state, settledAt } : null,
    },
    release: {
      chainId: inputs.provenance.chainId,
      releaseId: inputs.provenance.releaseId,
      deploymentBlock: inputs.provenance.deploymentBlock,
      artifactChecksum: inputs.provenance.artifactChecksum,
    },
  };
}

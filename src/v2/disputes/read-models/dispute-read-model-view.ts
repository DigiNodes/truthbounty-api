import { DataState } from '../../common/data-state.enum';
import { DisputeStatus, ProjectDispute } from '../entities/project-dispute.entity';
import {
  DisputeReadModelItem,
  DisputeReadModelPhase,
  BondDisposition,
  AppealAvailabilityReason,
  ReleaseProvenance,
  DisputeLastEvent,
  DisputeDeadlines,
  DisputeBond,
  DisputeAppeal,
  DisputeOutcome,
  DisputeTimelineEvent,
  DisputeSettlement,
} from './dispute-read-model.types';

export interface DisputeReadModelViewOptions {
  provenance: ReleaseProvenance;
  dataState: DataState;
  /** Clock for deadline checks (injectable for tests). */
  now?: Date;
  /** Optional max appeal round gate from contract config. */
  maxAppealRound?: number;
  /** Optional provisional outcome from the challenged round. */
  provisionalOutcome?: string | null;
  /** Optional bond disposition from terminal payload when status is resolved. */
  terminalBondDisposition?: BondDisposition | null;
  /** Optional settlement data from reward projection. */
  settlement?: DisputeSettlement;
}

function parseRoundIndex(roundId: string): number | null {
  const m = String(roundId).match(/(\d+)\s*$/);
  if (!m) return null;
  return Number(m[1]);
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Convert a ProjectDispute entity to a DisputeReadModelItem.
 *
 * This view function:
 * - Separates provisional and final outcomes (never mixes them)
 * - Derives phase from contract-derived fields only
 * - Derives appeal availability from contract-derived fields only
 * - Preserves exact integer strings for economic values
 * - Fails closed on ambiguous bond disposition (returns 'unknown')
 */
export function toDisputeReadModelItem(
  dispute: ProjectDispute,
  options: DisputeReadModelViewOptions,
): DisputeReadModelItem {
  const now = options.now ?? new Date();
  const isTerminal =
    dispute.status === DisputeStatus.RESOLVED ||
    dispute.status === DisputeStatus.EXPIRED;

  // --- Appeal availability (contract-derived fields only) ---
  let appealAvailable = false;
  let appealReason: AppealAvailabilityReason = 'no_deadline';

  if (isTerminal) {
    appealAvailable = false;
    appealReason = 'already_final';
  } else if (
    options.maxAppealRound != null &&
    parseRoundIndex(dispute.originalRoundId) != null &&
    (parseRoundIndex(dispute.originalRoundId) as number) >= options.maxAppealRound
  ) {
    appealAvailable = false;
    appealReason = 'max_round';
  } else if (!dispute.deadline) {
    appealAvailable = false;
    appealReason = 'no_deadline';
  } else if (now.getTime() > new Date(dispute.deadline).getTime()) {
    appealAvailable = false;
    appealReason = 'deadline_passed';
  } else {
    appealAvailable = true;
    appealReason = 'window_open';
  }

  // --- Phase ---
  let phase: DisputeReadModelPhase;
  if (isTerminal) {
    phase = 'finalized';
  } else if (appealAvailable) {
    phase = 'appealable';
  } else {
    phase = 'provisional';
  }

  // --- Bond disposition (exact; no invented amounts) ---
  let disposition: BondDisposition = 'unknown';
  if (dispute.status === DisputeStatus.RAISED) {
    disposition = 'locked';
  } else if (dispute.status === DisputeStatus.EXPIRED) {
    disposition = 'refunded';
  } else if (dispute.status === DisputeStatus.RESOLVED) {
    disposition = options.terminalBondDisposition ?? 'unknown';
  }

  // --- Timeline ---
  const timeline: DisputeTimelineEvent[] = [
    {
      ref: dispute.status === DisputeStatus.RAISED ? 'raise' : dispute.status === DisputeStatus.RESOLVED ? 'resolved' : 'expired',
      txHash: dispute.eventTxHash,
      logIndex: dispute.eventLogIndex,
      blockNumber: String(dispute.blockNumber),
      at: dispute.createdAt.toISOString(),
    },
  ];

  // --- Deadlines ---
  const deadlines: DisputeDeadlines = {
    dispute: toIso(dispute.deadline),
    appeal: null, // TODO: derive from verification round appeal deadline
    settledAt: toIso(dispute.status === DisputeStatus.RESOLVED || dispute.status === DisputeStatus.EXPIRED ? dispute.updatedAt : null),
  };

  // --- Bond ---
  const bond: DisputeBond = {
    amount: dispute.challengeBond,
    asset: dispute.challengeBondAsset,
    disposition,
  };

  // --- Appeal ---
  const appeal: DisputeAppeal = {
    available: appealAvailable,
    appealRoundId: dispute.appealRoundId,
    reason: appealReason,
  };

  // --- Outcome (phase-separated) ---
  const outcome: DisputeOutcome = {
    phase,
    provisional:
      phase === 'finalized'
        ? null
        : {
            status: dispute.status,
            outcome: options.provisionalOutcome ?? null,
            deadline: toIso(dispute.deadline),
          },
    final:
      phase === 'finalized'
        ? {
            status: dispute.status === DisputeStatus.RESOLVED ? ('resolved' as const) : ('expired' as const),
            outcome: dispute.status === DisputeStatus.RESOLVED ? dispute.resolvedOutcome : null,
            settledAt: toIso(dispute.updatedAt),
          }
        : null,
  };

  // --- Settlement ---
  const settlement: DisputeSettlement = options.settlement ?? {
    pending: false,
    state: null,
    rewardAmount: null,
    refundAmount: null,
    slashedAmount: null,
  };

  // --- Last event ---
  const lastEvent: DisputeLastEvent = {
    blockNumber: String(dispute.blockNumber),
    eventIndex: dispute.eventLogIndex,
    txHash: dispute.eventTxHash,
    at: dispute.updatedAt.toISOString(),
  };

  return {
    disputeId: dispute.disputeId,
    claimId: dispute.claimId,
    originalRoundId: dispute.originalRoundId,
    chainId: options.provenance.chainId,
    status: dispute.status,
    dataState: options.dataState,
    phase,
    lastEvent,
    deadlines,
    bond,
    appeal,
    outcome,
    settlement,
    timeline,
    release: options.provenance,
  };
}

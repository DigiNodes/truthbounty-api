import { DataState } from '../common/data-state.enum';
import { DisputeStatus, ProjectDispute } from './entities/project-dispute.entity';

/** Dispute lifecycle phase — distinct from chain DataState (observed/safe/finalized). */
export type DisputePhase = 'provisional' | 'appealable' | 'finalized';

export type BondDisposition = 'locked' | 'refunded' | 'slashed' | 'unknown';

export interface DisputeLifecycleView {
  disputeId: string;
  claimId: string;
  originalRoundId: string;
  /** Chain finality of the last applied event — NOT dispute outcome finality. */
  chainDataState: DataState;
  phase: DisputePhase;
  provisional: {
    /** Non-final only; never copied into `final`. */
    outcome: string | null;
    deadline: string | null;
  } | null;
  appeal: {
    available: boolean;
    appealRoundId: string | null;
    /** Machine-readable reason derived from projected contract fields. */
    reason:
      | 'window_open'
      | 'deadline_passed'
      | 'already_final'
      | 'max_round'
      | 'no_deadline';
  };
  bond: {
    amount: string | null;
    asset: string | null;
    disposition: BondDisposition;
  };
  /** Set only when phase === 'finalized'; never holds provisional data. */
  final: {
    status: 'resolved' | 'expired';
    outcome: string | null;
  } | null;
  timeline: Array<{
    ref: 'raise_or_terminal';
    txHash: string;
    logIndex: number;
    blockNumber: string;
  }>;
}

export interface LifecycleOptions {
  /** Clock for deadline checks (injectable for tests). */
  now?: Date;
  /**
   * Optional max appeal round gate from contract config.
   * When originalRoundId is at/above max, appeal is unavailable.
   */
  maxAppealRound?: number;
  /** Optional provisional outcome from the challenged round (never written to `final`). */
  provisionalOutcome?: string | null;
  /** Optional bond disposition from terminal payload when status is resolved. */
  terminalBondDisposition?: BondDisposition | null;
}

function parseRoundIndex(roundId: string): number | null {
  const m = String(roundId).match(/(\d+)\s*$/);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * PREWAVE-BE-066: map a projected dispute row to a phase-separated API view.
 * Fail closed: unknown/ambiguous terminal bond → disposition "unknown".
 */
export function toDisputeLifecycleView(
  dispute: ProjectDispute,
  chainDataState: DataState,
  options: LifecycleOptions = {},
): DisputeLifecycleView {
  const now = options.now ?? new Date();
  const isTerminal =
    dispute.status === DisputeStatus.RESOLVED ||
    dispute.status === DisputeStatus.EXPIRED;

  // --- Appeal availability (contract-derived fields only) ---
  let appealAvailable = false;
  let appealReason: DisputeLifecycleView['appeal']['reason'] = 'no_deadline';

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
    // No deadline projected → cannot claim appeal window is open.
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
  let phase: DisputePhase;
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
    // Expiry path is refund-only in protocol terms when no resolve occurred.
    disposition = 'refunded';
  } else if (dispute.status === DisputeStatus.RESOLVED) {
    disposition = options.terminalBondDisposition ?? 'unknown';
  }

  const provisional =
    phase === 'finalized'
      ? null
      : {
          outcome: options.provisionalOutcome ?? null,
          deadline: dispute.deadline
            ? new Date(dispute.deadline).toISOString()
            : null,
        };

  const final =
    phase === 'finalized'
      ? {
          status:
            dispute.status === DisputeStatus.RESOLVED
              ? ('resolved' as const)
              : ('expired' as const),
          // Only terminal outcome — never provisional.
          outcome:
            dispute.status === DisputeStatus.RESOLVED
              ? dispute.resolvedOutcome
              : null,
        }
      : null;

  return {
    disputeId: dispute.disputeId,
    claimId: dispute.claimId,
    originalRoundId: dispute.originalRoundId,
    chainDataState,
    phase,
    provisional,
    appeal: {
      available: appealAvailable,
      appealRoundId: dispute.appealRoundId,
      reason: appealReason,
    },
    bond: {
      amount: dispute.challengeBond,
      asset: dispute.challengeBondAsset,
      disposition,
    },
    final,
    timeline: [
      {
        ref: 'raise_or_terminal',
        txHash: dispute.eventTxHash,
        logIndex: dispute.eventLogIndex,
        blockNumber: String(dispute.blockNumber),
      },
    ],
  };
}

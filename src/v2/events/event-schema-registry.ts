/**
 * Declarative mapping from a canonical event name to the argument names (as
 * they appear in the decoded ABI args) that populate the shared normalized
 * columns (actor/claimId/roundId/asset/amount) on CanonicalEvent.
 *
 * The claim lifecycle mappings below use argument names from the pinned
 * Optimism Sepolia release ABI. Other V2 mappings still include assumptions
 * that must be reconciled against their approved artifacts.
 *
 * Fields consumed from the free-form `payload` JSON by downstream
 * projectors (not part of this shared-column mapping, since they aren't
 * common across event types) carry the same flagged assumption:
 * VerificationRoundOpened.{roundType, roundNumber, deadline},
 * PositionCommitted.{stake, reputationInput, effectiveWeight, verdict},
 * DisputeRaised.{deadline, appealRoundId}, DisputeResolved.{outcome},
 * RewardPoolSettled.{poolId}, RewardAllocated.{kind, beneficiary,
 * sourcePoolId, allocationId}, RewardClaimed.{allocationId, kind,
 * beneficiary}. See verification-projector.service.ts,
 * disputes-projector.service.ts and rewards-projector.service.ts.
 */
export interface EventFieldMapping {
  actor?: string;
  claimId?: string;
  roundId?: string;
  asset?: string;
  amount?: string;
}

export const EVENT_SCHEMA_REGISTRY: Record<string, EventFieldMapping> = {
  // Claim lifecycle events and argument names are pinned by the release ABI.
  ClaimSubmitted: { actor: 'author', claimId: 'claimId' },
  ClaimStatusChanged: { claimId: 'claimId' },
  VerdictSettled: { claimId: 'claimId' },

  // Evidence lifecycle (V2-BE-013)
  EvidenceRegistered: { actor: 'submitter', claimId: 'claimId' },
  EvidenceReplaced: { actor: 'submitter', claimId: 'claimId' },
  EvidenceRemoved: { actor: 'actor', claimId: 'claimId' },

  // Verification rounds and positions (V2-BE-014)
  VerificationRoundOpened: { claimId: 'claimId', roundId: 'roundId' },
  PositionCommitted: {
    actor: 'participant',
    claimId: 'claimId',
    roundId: 'roundId',
  },

  // Disputes and appeals (V2-BE-016)
  DisputeRaised: {
    actor: 'challenger',
    claimId: 'claimId',
    roundId: 'roundId',
    asset: 'bondAsset',
    amount: 'bondAmount',
  },
  DisputeResolved: { claimId: 'claimId', roundId: 'roundId' },
  DisputeExpired: { claimId: 'claimId', roundId: 'roundId' },

  // Reward allocations and claim progress (V2-BE-017)
  RewardPoolSettled: {
    claimId: 'claimId',
    asset: 'asset',
    amount: 'amount',
  },
  RewardAllocated: {
    actor: 'beneficiary',
    claimId: 'claimId',
    roundId: 'roundId',
    asset: 'asset',
    amount: 'amount',
  },
  RewardClaimed: {
    actor: 'beneficiary',
    claimId: 'claimId',
    asset: 'asset',
    amount: 'amount',
  },
};

/** Every event name this pipeline currently knows how to normalize. */
export const KNOWN_EVENT_NAMES = new Set(Object.keys(EVENT_SCHEMA_REGISTRY));

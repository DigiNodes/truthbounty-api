/**
 * Declarative mapping from a canonical event name to the argument names (as
 * they appear in the decoded ABI args) that populate the shared normalized
 * columns (actor/claimId/roundId/asset/amount) on CanonicalEvent.
 *
 * ASSUMPTION FLAGGED FOR REVIEW: V2-BE-008 (approved artifact import) has not
 * landed, so there is no frozen ABI to read real argument names from yet.
 * The argument names below follow the naming used throughout the V2 issue
 * descriptions themselves (actor, claimId, roundId, asset, amount) and are
 * intended as the contract-facing convention this pipeline expects; they are
 * expected to be reconciled against the real approved ABI once V2-BE-008
 * lands. Nothing here changes protocol meaning: it only says where to find
 * each field's value in whatever the approved ABI turns out to expose.
 */
export interface EventFieldMapping {
  actor?: string;
  claimId?: string;
  roundId?: string;
  asset?: string;
  amount?: string;
}

export const EVENT_SCHEMA_REGISTRY: Record<string, EventFieldMapping> = {
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
};

/** Every event name this pipeline currently knows how to normalize. */
export const KNOWN_EVENT_NAMES = new Set(Object.keys(EVENT_SCHEMA_REGISTRY));

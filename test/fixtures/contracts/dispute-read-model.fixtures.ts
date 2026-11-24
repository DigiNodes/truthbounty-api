/**
 * PREWAVE-BE-007 — Sanitized fixtures for the versioned dispute read models.
 *
 * Every approved UI state the frontend must be able to render has a fixture
 * here: register (provisional + appealable + finalized), detail (provisional +
 * appealable + finalized), empty register, tie/refund-only paths, unavailable
 * paths, and each fail-closed state (stale, unknown dispute, wrong release,
 * reorg recovery).
 *
 * Fixtures are typed against the published response contracts, so a field
 * rename that is not reflected here fails the drift test rather than silently
 * drifting the frontend contract.
 *
 * Security constraints (enforced by dispute-read-model.spec.ts):
 *  - no private keys, secrets, authorization material, protected rationale,
 *    or non-public evidence content appears in any fixture,
 *  - all chain-derived data binds to the canonical release,
 *  - provisional data is never marked final.
 */

import { DataState } from '../../../src/v2/common/data-state.enum';
import {
  DISPUTE_READ_MODEL_VERSION,
  DisputeReadModelDetailResponse,
  DisputeReadModelErrorBody,
  DisputeReadModelListResponse,
  ReleaseProvenance,
} from '../../../src/v2/disputes/read-models/dispute-read-model.types';

// ---------------------------------------------------------------------------
// Canonical release + version binding
// ---------------------------------------------------------------------------

/** Mirrors contracts/manifests/optimism-sepolia.release.json. */
export const CANONICAL_DISPUTE_READ_MODEL_RELEASE: ReleaseProvenance = {
  chainId: 11155420,
  releaseId: 'rel-opsepolia-20261015-v2',
  deploymentBlock: 24850000,
  artifactChecksum:
    'f183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22f',
};

export const DISPUTE_READ_MODEL_FIXTURE_RELEASE_VERSION =
  DISPUTE_READ_MODEL_VERSION;

const OBSERVED_AT = '2026-10-16T00:00:00.000Z';
const SNAPSHOT_AT = '2026-10-16T00:00:00.000Z';

const HEALTHY_FRESHNESS = {
  indexedBlock: '24860000',
  safeBlock: '24860010',
  finalizedBlock: '24860000',
  observedHead: 24860012,
  lagBlocks: '12',
  lastSuccess: '2026-10-16T00:00:00.000Z',
  stale: false,
  staleReasons: [] as string[],
  reorgDetected: false,
};

const PROVENANCE = CANONICAL_DISPUTE_READ_MODEL_RELEASE;

const RELEASE = { ...CANONICAL_DISPUTE_READ_MODEL_RELEASE };

function item(
  overrides: Partial<DisputeReadModelListResponse['data'][number]>,
): DisputeReadModelListResponse['data'][number] {
  return {
    disputeId: 'claim-0001:round-1',
    claimId: 'claim-0001',
    originalRoundId: 'round-1',
    chainId: CANONICAL_DISPUTE_READ_MODEL_RELEASE.chainId,
    status: 'raised',
    dataState: DataState.OBSERVED,
    phase: 'provisional',
    lastEvent: {
      blockNumber: '24850010',
      eventIndex: 0,
      txHash: '0x' + '1'.repeat(64),
      at: '2026-10-15T00:00:00.000Z',
    },
    deadlines: {
      dispute: '2026-10-20T00:00:00.000Z',
      appeal: null,
      settledAt: null,
    },
    bond: {
      amount: '1000000000000000000',
      asset: '0x' + 'a'.repeat(40),
      disposition: 'locked',
    },
    appeal: {
      available: true,
      appealRoundId: 'round-2',
      reason: 'window_open',
    },
    outcome: {
      phase: 'provisional',
      provisional: {
        status: 'raised',
        outcome: null,
        deadline: '2026-10-20T00:00:00.000Z',
      },
      final: null,
    },
    settlement: {
      pending: false,
      state: null,
      rewardAmount: null,
      refundAmount: null,
      slashedAmount: null,
    },
    timeline: [
      {
        ref: 'raise',
        txHash: '0x' + '1'.repeat(64),
        logIndex: 0,
        blockNumber: '24850010',
        at: '2026-10-15T00:00:00.000Z',
      },
    ],
    release: RELEASE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// List fixtures
// ---------------------------------------------------------------------------

export const DISPUTE_REGISTER_EMPTY: DisputeReadModelListResponse = {
  readModel: 'dispute-register',
  readModelVersion: DISPUTE_READ_MODEL_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  pagination: {
    nextCursor: null,
    hasMore: false,
    limit: 20,
    order: 'disputeId:asc',
    snapshotAt: SNAPSHOT_AT,
  },
  data: [],
};

export const DISPUTE_REGISTER_PROVISIONAL: DisputeReadModelListResponse = {
  readModel: 'dispute-register',
  readModelVersion: DISPUTE_READ_MODEL_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  pagination: {
    nextCursor: null,
    hasMore: false,
    limit: 20,
    order: 'disputeId:asc',
    snapshotAt: SNAPSHOT_AT,
  },
  data: [
    item({
      disputeId: 'claim-0001:round-1',
      claimId: 'claim-0001',
      originalRoundId: 'round-1',
      status: 'raised',
      dataState: DataState.OBSERVED,
      phase: 'provisional',
      deadlines: {
        dispute: '2026-10-20T00:00:00.000Z',
        appeal: null,
        settledAt: null,
      },
      bond: {
        amount: '1000000000000000000',
        asset: '0x' + 'a'.repeat(40),
        disposition: 'locked',
      },
      appeal: {
        available: false,
        appealRoundId: null,
        reason: 'deadline_passed',
      },
      outcome: {
        phase: 'provisional',
        provisional: {
          status: 'raised',
          outcome: null,
          deadline: '2026-10-20T00:00:00.000Z',
        },
        final: null,
      },
    }),
  ],
};

export const DISPUTE_REGISTER_APPEALABLE: DisputeReadModelListResponse = {
  readModel: 'dispute-register',
  readModelVersion: DISPUTE_READ_MODEL_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  pagination: {
    nextCursor: null,
    hasMore: false,
    limit: 20,
    order: 'disputeId:asc',
    snapshotAt: SNAPSHOT_AT,
  },
  data: [
    item({
      disputeId: 'claim-0002:round-1',
      claimId: 'claim-0002',
      originalRoundId: 'round-1',
      status: 'raised',
      dataState: DataState.SAFE,
      phase: 'appealable',
      deadlines: {
        dispute: '2026-10-25T00:00:00.000Z',
        appeal: '2026-10-26T00:00:00.000Z',
        settledAt: null,
      },
      bond: {
        amount: '2000000000000000000',
        asset: '0x' + 'b'.repeat(40),
        disposition: 'locked',
      },
      appeal: {
        available: true,
        appealRoundId: 'round-2',
        reason: 'window_open',
      },
      outcome: {
        phase: 'appealable',
        provisional: {
          status: 'raised',
          outcome: null,
          deadline: '2026-10-25T00:00:00.000Z',
        },
        final: null,
      },
    }),
  ],
};

export const DISPUTE_REGISTER_FINALIZED: DisputeReadModelListResponse = {
  readModel: 'dispute-register',
  readModelVersion: DISPUTE_READ_MODEL_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  pagination: {
    nextCursor: null,
    hasMore: false,
    limit: 20,
    order: 'disputeId:asc',
    snapshotAt: SNAPSHOT_AT,
  },
  data: [
    item({
      disputeId: 'claim-0003:round-1',
      claimId: 'claim-0003',
      originalRoundId: 'round-1',
      status: 'resolved',
      dataState: DataState.FINALIZED,
      phase: 'finalized',
      lastEvent: {
        blockNumber: '24850020',
        eventIndex: 0,
        txHash: '0x' + '2'.repeat(64),
        at: '2026-10-15T01:00:00.000Z',
      },
      deadlines: {
        dispute: '2026-10-20T00:00:00.000Z',
        appeal: null,
        settledAt: '2026-10-15T01:00:00.000Z',
      },
      bond: {
        amount: '1500000000000000000',
        asset: '0x' + 'c'.repeat(40),
        disposition: 'slashed',
      },
      appeal: {
        available: false,
        appealRoundId: null,
        reason: 'already_final',
      },
      outcome: {
        phase: 'finalized',
        provisional: null,
        final: {
          status: 'resolved',
          outcome: 'overturned',
          settledAt: '2026-10-15T01:00:00.000Z',
        },
      },
      timeline: [
        {
          ref: 'resolved',
          txHash: '0x' + '2'.repeat(64),
          logIndex: 0,
          blockNumber: '24850020',
          at: '2026-10-15T01:00:00.000Z',
        },
      ],
    }),
  ],
};

// ---------------------------------------------------------------------------
// Detail fixtures
// ---------------------------------------------------------------------------

export const DISPUTE_DETAIL_PROVISIONAL: DisputeReadModelDetailResponse = {
  readModel: 'dispute-detail',
  readModelVersion: DISPUTE_READ_MODEL_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  data: item({
    disputeId: 'claim-0001:round-1',
    claimId: 'claim-0001',
    originalRoundId: 'round-1',
    status: 'raised',
    dataState: DataState.OBSERVED,
    phase: 'provisional',
    appeal: {
      available: false,
      appealRoundId: null,
      reason: 'deadline_passed',
    },
  }),
};

export const DISPUTE_DETAIL_APPEALABLE: DisputeReadModelDetailResponse = {
  readModel: 'dispute-detail',
  readModelVersion: DISPUTE_READ_MODEL_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  data: item({
    disputeId: 'claim-0002:round-1',
    claimId: 'claim-0002',
    originalRoundId: 'round-1',
    status: 'raised',
    dataState: DataState.SAFE,
    phase: 'appealable',
    appeal: {
      available: true,
      appealRoundId: 'round-2',
      reason: 'window_open',
    },
  }),
};

export const DISPUTE_DETAIL_FINALIZED: DisputeReadModelDetailResponse = {
  readModel: 'dispute-detail',
  readModelVersion: DISPUTE_READ_MODEL_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  data: item({
    disputeId: 'claim-0003:round-1',
    claimId: 'claim-0003',
    originalRoundId: 'round-1',
    status: 'resolved',
    dataState: DataState.FINALIZED,
    phase: 'finalized',
    lastEvent: {
      blockNumber: '24850020',
      eventIndex: 0,
      txHash: '0x' + '2'.repeat(64),
      at: '2026-10-15T01:00:00.000Z',
    },
    deadlines: {
      dispute: '2026-10-20T00:00:00.000Z',
      appeal: null,
      settledAt: '2026-10-15T01:00:00.000Z',
    },
    bond: {
      amount: '1500000000000000000',
      asset: '0x' + 'c'.repeat(40),
      disposition: 'slashed',
    },
    appeal: {
      available: false,
      appealRoundId: null,
      reason: 'already_final',
    },
    outcome: {
      phase: 'finalized',
      provisional: null,
      final: {
        status: 'resolved',
        outcome: 'overturned',
        settledAt: '2026-10-15T01:00:00.000Z',
      },
    },
    timeline: [
      {
        ref: 'resolved',
        txHash: '0x' + '2'.repeat(64),
        logIndex: 0,
        blockNumber: '24850020',
        at: '2026-10-15T01:00:00.000Z',
      },
    ],
  }),
};

// ---------------------------------------------------------------------------
// Tie/refund-only fixtures
// ---------------------------------------------------------------------------

export const DISPUTE_DETAIL_REFUND_ONLY: DisputeReadModelDetailResponse = {
  readModel: 'dispute-detail',
  readModelVersion: DISPUTE_READ_MODEL_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  data: item({
    disputeId: 'claim-0004:round-1',
    claimId: 'claim-0004',
    originalRoundId: 'round-1',
    status: 'expired',
    dataState: DataState.FINALIZED,
    phase: 'finalized',
    lastEvent: {
      blockNumber: '24850030',
      eventIndex: 0,
      txHash: '0x' + '3'.repeat(64),
      at: '2026-10-15T02:00:00.000Z',
    },
    deadlines: {
      dispute: '2026-10-20T00:00:00.000Z',
      appeal: null,
      settledAt: '2026-10-15T02:00:00.000Z',
    },
    bond: {
      amount: '1000000000000000000',
      asset: '0x' + 'd'.repeat(40),
      disposition: 'refunded',
    },
    appeal: {
      available: false,
      appealRoundId: null,
      reason: 'already_final',
    },
    outcome: {
      phase: 'finalized',
      provisional: null,
      final: {
        status: 'expired',
        outcome: null,
        settledAt: '2026-10-15T02:00:00.000Z',
      },
    },
    timeline: [
      {
        ref: 'expired',
        txHash: '0x' + '3'.repeat(64),
        logIndex: 0,
        blockNumber: '24850030',
        at: '2026-10-15T02:00:00.000Z',
      },
    ],
  }),
};

export const DISPUTE_DETAIL_TIE: DisputeReadModelDetailResponse = {
  readModel: 'dispute-detail',
  readModelVersion: DISPUTE_READ_MODEL_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  data: item({
    disputeId: 'claim-0005:round-1',
    claimId: 'claim-0005',
    originalRoundId: 'round-1',
    status: 'resolved',
    dataState: DataState.FINALIZED,
    phase: 'finalized',
    lastEvent: {
      blockNumber: '24850040',
      eventIndex: 0,
      txHash: '0x' + '4'.repeat(64),
      at: '2026-10-15T03:00:00.000Z',
    },
    deadlines: {
      dispute: '2026-10-20T00:00:00.000Z',
      appeal: null,
      settledAt: '2026-10-15T03:00:00.000Z',
    },
    bond: {
      amount: '1000000000000000000',
      asset: '0x' + 'e'.repeat(40),
      disposition: 'refunded',
    },
    appeal: {
      available: false,
      appealRoundId: null,
      reason: 'already_final',
    },
    outcome: {
      phase: 'finalized',
      provisional: null,
      final: {
        status: 'resolved',
        outcome: 'tie',
        settledAt: '2026-10-15T03:00:00.000Z',
      },
    },
    timeline: [
      {
        ref: 'resolved',
        txHash: '0x' + '4'.repeat(64),
        logIndex: 0,
        blockNumber: '24850040',
        at: '2026-10-15T03:00:00.000Z',
      },
    ],
  }),
};

// ---------------------------------------------------------------------------
// Unavailable path fixtures
// ---------------------------------------------------------------------------

export const DISPUTE_DETAIL_UNAVAILABLE_NO_DEADLINE: DisputeReadModelDetailResponse = {
  readModel: 'dispute-detail',
  readModelVersion: DISPUTE_READ_MODEL_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  data: item({
    disputeId: 'claim-0006:round-1',
    claimId: 'claim-0006',
    originalRoundId: 'round-1',
    status: 'raised',
    dataState: DataState.OBSERVED,
    phase: 'provisional',
    deadlines: {
      dispute: null,
      appeal: null,
      settledAt: null,
    },
    bond: {
      amount: '1000000000000000000',
      asset: '0x' + 'f'.repeat(40),
      disposition: 'locked',
    },
    appeal: {
      available: false,
      appealRoundId: null,
      reason: 'no_deadline',
    },
    outcome: {
      phase: 'provisional',
      provisional: {
        status: 'raised',
        outcome: null,
        deadline: null,
      },
      final: null,
    },
  }),
};

export const DISPUTE_DETAIL_UNAVAILABLE_MAX_ROUND: DisputeReadModelDetailResponse = {
  readModel: 'dispute-detail',
  readModelVersion: DISPUTE_READ_MODEL_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  data: item({
    disputeId: 'claim-0007:round-10',
    claimId: 'claim-0007',
    originalRoundId: 'round-10',
    status: 'raised',
    dataState: DataState.OBSERVED,
    phase: 'provisional',
    deadlines: {
      dispute: '2026-10-20T00:00:00.000Z',
      appeal: null,
      settledAt: null,
    },
    bond: {
      amount: '1000000000000000000',
      asset: '0x' + '0'.repeat(40),
      disposition: 'locked',
    },
    appeal: {
      available: false,
      appealRoundId: null,
      reason: 'max_round',
    },
    outcome: {
      phase: 'provisional',
      provisional: {
        status: 'raised',
        outcome: null,
        deadline: '2026-10-20T00:00:00.000Z',
      },
      final: null,
    },
  }),
};

// ---------------------------------------------------------------------------
// Fail-closed error fixtures
// ---------------------------------------------------------------------------

export const DISPUTE_READ_MODEL_ERROR_STALE: DisputeReadModelErrorBody = {
  code: 'STALE_RECONCILIATION',
  message: 'Dispute read models are not fresh enough to serve; failing closed',
  failClosed: true,
  reason: 'finality_unavailable',
  provenance: PROVENANCE,
};

export const DISPUTE_READ_MODEL_ERROR_WRONG_RELEASE: DisputeReadModelErrorBody = {
  code: 'INVALID_ARTIFACT_VERSION',
  message: 'Requested release is not the release the dispute read models are bound to',
  failClosed: true,
  reason: 'wrong_release',
  provenance: PROVENANCE,
  expected: { releaseId: 'rel-opsepolia-20261015-v2' },
  received: { releaseId: 'rel-opsepolia-20261014-v1' },
};

export const DISPUTE_READ_MODEL_ERROR_UNSUPPORTED_CHAIN: DisputeReadModelErrorBody = {
  code: 'UNSUPPORTED_CHAIN',
  message: 'Requested chain is not the release the dispute read models are bound to',
  failClosed: true,
  reason: 'chain_release_mismatch',
  provenance: PROVENANCE,
  expected: { chainId: 11155420 },
  received: { chainId: 1 },
};

export const DISPUTE_READ_MODEL_ERROR_NOT_FOUND: DisputeReadModelErrorBody = {
  code: 'NOT_FOUND',
  message: 'No canonical dispute read model is published for dispute unknown:round-1',
  failClosed: true,
  reason: 'dispute_not_projected',
  provenance: PROVENANCE,
};

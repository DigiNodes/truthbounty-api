/**
 * PREWAVE-BE-005 — Sanitized fixtures for the versioned claim read models.
 *
 * Every approved UI state the frontend must be able to render has a fixture
 * here: list (provisional + finalized), detail (provisional + finalized),
 * empty list, evidence missing/not-finalized, and each fail-closed state
 * (stale, unknown claim, wrong release, reorg recovery).
 *
 * Fixtures are typed against the published response contracts, so a field
 * rename that is not reflected here fails the drift test rather than silently
 * drifting the frontend contract.
 *
 * Security constraints (enforced by claim-read-model.spec.ts):
 *  - no private keys, secrets, authorization material, protected rationale,
 *    or non-public evidence content appears in any fixture,
 *  - all chain-derived data binds to the canonical release,
 *  - provisional data is never marked final.
 */

import { DataState } from '../../../src/v2/common/data-state.enum';
import {
  CLAIM_READ_MODEL_VERSION,
  ClaimReadModelDetailResponse,
  ClaimReadModelErrorBody,
  ClaimReadModelListResponse,
  ReleaseProvenance,
} from '../../../src/claims/v2/read-models/claim-read-model.types';

// ---------------------------------------------------------------------------
// Canonical release + version binding
// ---------------------------------------------------------------------------

/** Mirrors contracts/manifests/optimism-sepolia.release.json. */
export const CANONICAL_CLAIM_READ_MODEL_RELEASE: ReleaseProvenance = {
  chainId: 11155420,
  releaseId: 'rel-opsepolia-20261015-v2',
  deploymentBlock: 24850000,
  artifactChecksum:
    'f183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22f',
};

export const CLAIM_READ_MODEL_FIXTURE_RELEASE_VERSION =
  CLAIM_READ_MODEL_VERSION;

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

const PROVENANCE = CANONICAL_CLAIM_READ_MODEL_RELEASE;

const RELEASE = { ...CANONICAL_CLAIM_READ_MODEL_RELEASE };

function item(
  overrides: Partial<ClaimReadModelListResponse['data'][number]>,
): ClaimReadModelListResponse['data'][number] {
  return {
    claimId: 'claim-0001',
    chainId: CANONICAL_CLAIM_READ_MODEL_RELEASE.chainId,
    state: 'SUBMITTED',
    dataState: DataState.OBSERVED,
    phase: 'provisional',
    lastEvent: {
      blockNumber: '24850010',
      eventIndex: 0,
      txHash: '0x' + '1'.repeat(64),
      at: '2026-10-15T00:00:00.000Z',
    },
    deadlines: {
      verification: '2026-10-20T00:00:00.000Z',
      appeal: null,
      settledAt: null,
    },
    evidence: {
      state: 'not_finalized',
      activeCount: 1,
      finalizedCount: 0,
      latestBlockNumber: '24850010',
    },
    outcome: {
      phase: 'provisional',
      provisional: { state: 'SUBMITTED', settledAt: null },
      final: null,
    },
    release: RELEASE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// List states
// ---------------------------------------------------------------------------

export const claimListProvisionalAndFinalized: ClaimReadModelListResponse = {
  readModel: 'claim-list',
  readModelVersion: CLAIM_READ_MODEL_FIXTURE_RELEASE_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  pagination: {
    nextCursor: 'eyJ2IjoxfQ',
    hasMore: true,
    limit: 20,
    order: 'claimId:asc',
    snapshotAt: SNAPSHOT_AT,
  },
  data: [
    item({ claimId: 'claim-0001', phase: 'provisional' }),
    item({
      claimId: 'claim-0002',
      state: 'SETTLED',
      dataState: DataState.FINALIZED,
      phase: 'finalized',
      lastEvent: {
        blockNumber: '24850020',
        eventIndex: 3,
        txHash: '0x' + '2'.repeat(64),
        at: '2026-10-15T06:00:00.000Z',
      },
      deadlines: {
        verification: '2026-10-18T00:00:00.000Z',
        appeal: null,
        settledAt: '2026-10-15T06:00:00.000Z',
      },
      evidence: {
        state: 'available',
        activeCount: 2,
        finalizedCount: 2,
        latestBlockNumber: '24850018',
      },
      outcome: {
        phase: 'finalized',
        provisional: null,
        final: { state: 'SETTLED', settledAt: '2026-10-15T06:00:00.000Z' },
      },
    }),
  ],
};

export const claimListEmpty: ClaimReadModelListResponse = {
  readModel: 'claim-list',
  readModelVersion: CLAIM_READ_MODEL_FIXTURE_RELEASE_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  pagination: {
    nextCursor: null,
    hasMore: false,
    limit: 20,
    order: 'claimId:asc',
    snapshotAt: SNAPSHOT_AT,
  },
  data: [],
};

// ---------------------------------------------------------------------------
// Detail states
// ---------------------------------------------------------------------------

export const claimDetailProvisional: ClaimReadModelDetailResponse = {
  readModel: 'claim-detail',
  readModelVersion: CLAIM_READ_MODEL_FIXTURE_RELEASE_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  data: item({
    claimId: 'claim-0001',
    state: 'UNDER_VERIFICATION',
    dataState: DataState.SAFE,
    phase: 'provisional',
    outcome: {
      phase: 'provisional',
      provisional: { state: 'UNDER_VERIFICATION', settledAt: null },
      final: null,
    },
  }),
};

export const claimDetailFinalized: ClaimReadModelDetailResponse = {
  readModel: 'claim-detail',
  readModelVersion: CLAIM_READ_MODEL_FIXTURE_RELEASE_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  data: item({
    claimId: 'claim-0002',
    state: 'SETTLED',
    dataState: DataState.FINALIZED,
    phase: 'finalized',
    deadlines: {
      verification: '2026-10-18T00:00:00.000Z',
      appeal: null,
      settledAt: '2026-10-15T06:00:00.000Z',
    },
    evidence: {
      state: 'available',
      activeCount: 2,
      finalizedCount: 2,
      latestBlockNumber: '24850018',
    },
    outcome: {
      phase: 'finalized',
      provisional: null,
      final: { state: 'SETTLED', settledAt: '2026-10-15T06:00:00.000Z' },
    },
  }),
};

export const claimEvidenceMissing: ClaimReadModelDetailResponse = {
  readModel: 'claim-detail',
  readModelVersion: CLAIM_READ_MODEL_FIXTURE_RELEASE_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  data: item({
    claimId: 'claim-0003',
    state: 'SUBMITTED',
    phase: 'provisional',
    evidence: {
      state: 'missing',
      activeCount: 0,
      finalizedCount: 0,
      latestBlockNumber: null,
    },
  }),
};

export const claimEvidenceNotFinalized: ClaimReadModelDetailResponse = {
  readModel: 'claim-detail',
  readModelVersion: CLAIM_READ_MODEL_FIXTURE_RELEASE_VERSION,
  observedAt: OBSERVED_AT,
  provenance: PROVENANCE,
  freshness: HEALTHY_FRESHNESS,
  data: item({
    claimId: 'claim-0004',
    state: 'UNDER_VERIFICATION',
    dataState: DataState.OBSERVED,
    phase: 'provisional',
    evidence: {
      state: 'not_finalized',
      activeCount: 1,
      finalizedCount: 0,
      latestBlockNumber: '24860012',
    },
  }),
};

// ---------------------------------------------------------------------------
// Fail-closed states
// ---------------------------------------------------------------------------

export const claimStale: ClaimReadModelErrorBody = {
  code: 'STALE_RECONCILIATION',
  message: 'Claim read models are not fresh enough to serve; failing closed',
  failClosed: true,
  reason: 'finality_unavailable',
  provenance: RELEASE,
};

export const claimUnknown: ClaimReadModelErrorBody = {
  code: 'NOT_FOUND',
  message: 'No canonical claim read model is published for claim claim-9999',
  failClosed: true,
  reason: 'claim_not_projected',
  provenance: RELEASE,
};

export const claimWrongRelease: ClaimReadModelErrorBody = {
  code: 'INVALID_ARTIFACT_VERSION',
  message:
    'Requested release is not the release the claim read models are bound to',
  failClosed: true,
  reason: 'wrong_release',
  provenance: RELEASE,
  expected: { releaseId: CANONICAL_CLAIM_READ_MODEL_RELEASE.releaseId },
  received: { releaseId: 'rel-mainnet-20990101-v9' },
};

export const claimReorgRecovery: ClaimReadModelErrorBody = {
  code: 'STALE_RECONCILIATION',
  message: 'Claim read models are not fresh enough to serve; failing closed',
  failClosed: true,
  reason: 'reorg_detected',
  provenance: RELEASE,
};

export const APPROVED_CLAIM_READ_MODEL_FIXTURES = {
  list: claimListProvisionalAndFinalized,
  listEmpty: claimListEmpty,
  detailProvisional: claimDetailProvisional,
  detailFinalized: claimDetailFinalized,
  evidenceMissing: claimEvidenceMissing,
  evidenceNotFinalized: claimEvidenceNotFinalized,
  stale: claimStale,
  unknown: claimUnknown,
  wrongRelease: claimWrongRelease,
  reorgRecovery: claimReorgRecovery,
} as const;

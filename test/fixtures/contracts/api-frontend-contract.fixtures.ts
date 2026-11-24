/**
 * PREWAVE-BE-090 — Approved API-Frontend Contract Fixtures
 * 
 * Binds canonical release and chain metadata (v2.0.0-sepolia, chain 11155420)
 * with approved UI data shapes, canonical enum vocabularies, and fail-closed state fixtures.
 */

export const CANONICAL_RELEASE_METADATA = {
  releaseVersion: 'v2.0.0-sepolia',
  protocolVersion: '2.0.0',
  abiVersion: '2.0.0',
  chainId: 11155420, // Optimism Sepolia
  network: 'optimism-sepolia',
} as const;

export const CANONICAL_CLAIM_STATUSES = [
  'OPEN',
  'UNDER_REVIEW',
  'VERIFIED',
  'REJECTED',
  'DISPUTED',
] as const;

export const CANONICAL_SETTLEMENT_STATES = [
  'PENDING_SETTLEMENT',
  'SETTLED',
  'SETTLEMENT_CLAIMED',
  'PENDING_APPEAL',
  'APPEAL_SETTLED',
  'APPEAL_CLAIMED',
  'FINALIZED',
] as const;

export const CANONICAL_ERROR_CODES = [
  'UNSUPPORTED_CHAIN',
  'INVALID_ADDRESS',
  'INVALID_ARTIFACT_VERSION',
  'INVALID_WALLET_ACCOUNT',
  'INVALID_AMOUNT',
  'INVALID_CONTENT',
  'ALLOWANCE_NOT_APPROVED',
  'SIMULATION_REVERTED',
  'USER_REJECTED',
  'STALE_RECONCILIATION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'SERVICE_UNAVAILABLE',
  'UNKNOWN',
] as const;

export interface ApprovedContractFixtures {
  release: typeof CANONICAL_RELEASE_METADATA;
  claim: {
    id: string;
    title: string;
    description: string;
    claimantAddress: string;
    status: (typeof CANONICAL_CLAIM_STATUSES)[number];
    bountyAmount: number;
    totalStaked: number;
    evidence: Array<{
      id: string;
      type: string;
      value: string;
      createdAt: string;
    }>;
    createdAt: string;
    updatedAt: string;
    releaseVersion: string;
    chainId: number;
  };
  verifier: {
    roundId: number;
    claimId: string;
    verifierAddress: string;
    decision: 'TRUE' | 'FALSE';
    stakeAmount: string;
    status: 'PENDING' | 'CONFIRMED' | 'FAILED';
    startTime: number;
    deadline: number;
    minStake: string;
    releaseVersion: string;
    chainId: number;
  };
  dispute: {
    claimId: string;
    originalRoundId: string;
    disputeId: string;
    decision: 'VERIFIED' | 'REJECTED';
    status: 'ACTIVE' | 'RESOLVED' | 'PENDING';
    totalStake: string;
    windowEndTime: string;
    isProvisional: boolean;
    isFinalized: boolean;
    releaseVersion: string;
    chainId: number;
  };
  admin: {
    isAuthorized: boolean;
    adminAddress: string;
    role: 'ADMINISTRATOR' | 'OPERATOR';
    healthMetrics: Array<{
      id: string;
      name: string;
      value: string;
      status: 'healthy' | 'warning' | 'degraded' | 'unavailable';
      lastUpdated: string;
    }>;
    operationalQueue: Array<{
      id: string;
      title: string;
      authority: 'PROTOCOL_OPERATOR' | 'EMERGENCY_ADMIN';
      risk: 'low' | 'medium' | 'high';
      status: 'pending' | 'in_progress' | 'completed';
    }>;
  };
  status: {
    freshness: {
      indexedHeight: number;
      finalizedHeight: number;
      lastUpdate: string;
      lag: number;
      chainHeadHeight: number;
      dependencies: Array<{
        name: string;
        status: 'healthy' | 'degraded' | 'unavailable';
        latencyMs: number;
      }>;
    };
    degradedState: {
      isDegraded: boolean;
      degradationReason?: 'indexer_lag' | 'dependency_failure' | 'stale_data' | 'partial_outage';
      affectedDependencies: string[];
    };
    releaseVersion: string;
    chainId: number;
  };
  support: {
    channel: string;
    status: 'online' | 'degraded' | 'offline';
    documentationUrl: string;
    emergencyContacts: string[];
    releaseVersion: string;
  };
  legal: {
    termsVersion: string;
    disclaimer: string;
    sanctionsCheckRequired: boolean;
    evidencePrivacyModel: 'public' | 'redacted' | 'zero_knowledge';
    governingLaw: string;
    releaseVersion: string;
  };
  stale: {
    isStale: true;
    error: {
      code: 'STALE_RECONCILIATION';
      message: string;
      currentBlock: number;
      lastIndexedBlock: number;
      lag: number;
    };
    action: 'FAIL_CLOSED';
  };
  denied: {
    isDenied: true;
    error: {
      code: 'UNAUTHORIZED' | 'FORBIDDEN';
      message: string;
      requiredRole?: string;
    };
    action: 'REJECT_MUTATION';
  };
  unavailable: {
    isUnavailable: true;
    error: {
      code: 'SERVICE_UNAVAILABLE';
      message: string;
      retryAfterSeconds: number;
    };
    action: 'CIRCUIT_BREAKER';
  };
  wrongRelease: {
    isWrongRelease: true;
    error: {
      code: 'INVALID_ARTIFACT_VERSION';
      message: string;
      expectedRelease: string;
      receivedRelease: string;
      expectedChainId: number;
      receivedChainId: number;
    };
    action: 'FAIL_CLOSED';
  };
}

export const APPROVED_FIXTURES_V2: ApprovedContractFixtures = {
  release: CANONICAL_RELEASE_METADATA,
  claim: {
    id: 'claim-001-v2',
    title: 'Optimism Sepolia L2 Finality Observation',
    description: 'Canonical projection fixture for frontend contract tests.',
    claimantAddress: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    status: 'OPEN',
    bountyAmount: 1.5,
    totalStaked: 0.25,
    evidence: [
      {
        id: 'ev-001',
        type: 'ipfs',
        value: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
        createdAt: '2026-10-15T12:00:00.000Z',
      },
    ],
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T12:00:00.000Z',
    releaseVersion: CANONICAL_RELEASE_METADATA.releaseVersion,
    chainId: CANONICAL_RELEASE_METADATA.chainId,
  },
  verifier: {
    roundId: 1,
    claimId: 'claim-001-v2',
    verifierAddress: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
    decision: 'TRUE',
    stakeAmount: '250000000000000000', // 0.25 ETH in wei
    status: 'CONFIRMED',
    startTime: 1792065600,
    deadline: 1792152000,
    minStake: '100000000000000000', // 0.1 ETH
    releaseVersion: CANONICAL_RELEASE_METADATA.releaseVersion,
    chainId: CANONICAL_RELEASE_METADATA.chainId,
  },
  dispute: {
    claimId: 'claim-001-v2',
    originalRoundId: 'round-001',
    disputeId: 'disp-001',
    decision: 'VERIFIED',
    status: 'ACTIVE',
    totalStake: '500000000000000000',
    windowEndTime: '2026-10-22T00:00:00.000Z',
    isProvisional: true,
    isFinalized: false,
    releaseVersion: CANONICAL_RELEASE_METADATA.releaseVersion,
    chainId: CANONICAL_RELEASE_METADATA.chainId,
  },
  admin: {
    isAuthorized: true,
    adminAddress: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
    role: 'ADMINISTRATOR',
    healthMetrics: [
      {
        id: 'metric-indexer',
        name: 'Indexer Head Sync',
        value: '100%',
        status: 'healthy',
        lastUpdated: '2026-10-15T14:00:00.000Z',
      },
      {
        id: 'metric-redis',
        name: 'Cache Key Latency',
        value: '2.4ms',
        status: 'healthy',
        lastUpdated: '2026-10-15T14:00:00.000Z',
      },
    ],
    operationalQueue: [
      {
        id: 'queue-001',
        title: 'Review Stale Block Cursor',
        authority: 'PROTOCOL_OPERATOR',
        risk: 'low',
        status: 'pending',
      },
    ],
  },
  status: {
    freshness: {
      indexedHeight: 18450100,
      finalizedHeight: 18450090,
      lastUpdate: '2026-10-15T14:00:00.000Z',
      lag: 0,
      chainHeadHeight: 18450100,
      dependencies: [
        {
          name: 'Optimism Sepolia RPC',
          status: 'healthy',
          latencyMs: 38,
        },
        {
          name: 'IPFS Gateway',
          status: 'healthy',
          latencyMs: 110,
        },
      ],
    },
    degradedState: {
      isDegraded: false,
      affectedDependencies: [],
    },
    releaseVersion: CANONICAL_RELEASE_METADATA.releaseVersion,
    chainId: CANONICAL_RELEASE_METADATA.chainId,
  },
  support: {
    channel: 'community-discord',
    status: 'online',
    documentationUrl: 'https://docs.truthbounty.io',
    emergencyContacts: ['security@truthbounty.io'],
    releaseVersion: CANONICAL_RELEASE_METADATA.releaseVersion,
  },
  legal: {
    termsVersion: '2.0.0',
    disclaimer: 'TruthBounty protocol is decentralized and governed by immutable smart contracts.',
    sanctionsCheckRequired: true,
    evidencePrivacyModel: 'redacted',
    governingLaw: 'Decentralized Consensus',
    releaseVersion: CANONICAL_RELEASE_METADATA.releaseVersion,
  },
  stale: {
    isStale: true,
    error: {
      code: 'STALE_RECONCILIATION',
      message: 'Indexer block lag exceeds allowed freshness threshold (lag: 150 blocks)',
      currentBlock: 18450250,
      lastIndexedBlock: 18450100,
      lag: 150,
    },
    action: 'FAIL_CLOSED',
  },
  denied: {
    isDenied: true,
    error: {
      code: 'FORBIDDEN',
      message: 'Wallet not authorized to perform administrative or moderated operation',
      requiredRole: 'ADMINISTRATOR',
    },
    action: 'REJECT_MUTATION',
  },
  unavailable: {
    isUnavailable: true,
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Indexer or downstream RPC dependency unavailable. Circuit breaker open.',
      retryAfterSeconds: 30,
    },
    action: 'CIRCUIT_BREAKER',
  },
  wrongRelease: {
    isWrongRelease: true,
    error: {
      code: 'INVALID_ARTIFACT_VERSION',
      message: 'Client requested unsupported or mismatched release artifact version',
      expectedRelease: 'v2.0.0-sepolia',
      receivedRelease: 'v1.0.0-legacy',
      expectedChainId: 11155420,
      receivedChainId: 1,
    },
    action: 'FAIL_CLOSED',
  },
};


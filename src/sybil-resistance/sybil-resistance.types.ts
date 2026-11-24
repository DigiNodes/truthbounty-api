import { BadRequestException } from '@nestjs/common';

/**
 * PREWAVE-BE-062: Supported Sybil Scoring Model Versions
 */
export type SybilModelVersion = '1.0.0' | '2.0.0' | (string & {});

/**
 * Risk classification levels
 */
export type SybilRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * Freshness evaluation status
 */
export type FeatureFreshnessStatus = 'FRESH' | 'STALE' | 'UNKNOWN';

/**
 * Appeal status enum
 */
export type AppealStatus = 'SUBMITTED' | 'UPHELD' | 'RESOLVED' | 'REJECTED';

/**
 * Canonical chain and release artifact authority binding
 */
export interface ChainArtifactAuthority {
  chainId: number;
  releaseId: string;
  artifactHash: string;
  contractAddress: string;
  finalizedThroughBlock: number;
}

/**
 * Feature provenance tracking per individual signal
 */
export interface FeatureProvenance {
  featureName:
    'worldcoin' | 'wallet_age' | 'staking' | 'accuracy' | (string & {});
  source: 'canonical_chain' | 'world_id' | 'wallet_registry' | 'claims_history';
  observedAt: string;
  freshnessMs: number;
  isStale: boolean;
  isMissing: boolean;
  details: Record<string, any>;
  sensitiveData?: {
    nullifierHash?: string;
    proof?: any;
    walletAddresses?: string[];
  };
}

/**
 * Raw signal data for Sybil scoring
 */
export interface SybilSignals {
  worldcoinVerified: boolean;
  worldcoinVerifiedAt?: Date | null;
  worldcoinNullifierHash?: string | null;
  worldcoinProof?: any;
  oldestWalletAgeMs: number;
  walletCount?: number;
  walletAddresses?: string[];
  totalStakedAmount: bigint;
  stakingEventCount?: number;
  stakingFinalizedBlock?: number;
  claimsVotedOn: number;
  claimsCorrect: number;
  featuresObservedAt?: {
    worldcoin?: Date;
    walletAge?: Date;
    staking?: Date;
    accuracy?: Date;
  };
}

/**
 * Model configuration specification
 */
export interface SybilModelConfig {
  version: SybilModelVersion;
  description: string;
  algorithm: string;
  weights: {
    worldcoin: number;
    walletAge: number;
    staking: number;
    accuracy: number;
  };
  thresholds: {
    walletAgeThresholdMs: number;
    minStakingForFullScore: bigint;
    minClaimsForAccuracyScore: number;
    maxFreshnessMs: number;
  };
  riskParameters: {
    baselinePriorRisk: number;
    missingFeatureRiskFloor: number;
    riskBands: {
      lowMax: number;
      mediumMax: number;
      highMax: number;
    };
  };
}

/**
 * Calculation details structure for explainability and provenance
 */
export interface CalculationDetails {
  version: string;
  worldcoinWeight: number;
  walletAgeWeight: number;
  stakingWeight: number;
  accuracyWeight: number;
  componentScores: {
    worldcoin: number;
    walletAge: number;
    staking: number;
    accuracy: number;
  };
  timestamp: string;
  explanation: string;
  riskScore: number;
  riskLevel: SybilRiskLevel;
  provenanceDigest: string;
  featureProvenance: Record<string, FeatureProvenance>;
  missingFeatures: string[];
  staleFeatures: string[];
}

/**
 * Result of computing a Sybil score
 */
export interface SybilScoreComputationResult {
  score: number; // Resistance score (0.0 = untrusted, 1.0 = highly trusted)
  riskScore: number; // Risk score (0.0 = zero risk, 1.0 = extreme risk)
  riskLevel: SybilRiskLevel;
  version: string;
  provenanceDigest: string;
  missingFeatures: string[];
  staleFeatures: string[];
  details: CalculationDetails;
}

/**
 * Publicly sanitized Sybil score view (strictly redacting sensitive data)
 */
export interface PublicSybilScoreView {
  userId: string;
  score: number;
  riskScore: number;
  riskLevel: SybilRiskLevel;
  version: string;
  provenanceDigest: string;
  calculatedAt: string;
  freshness: {
    status: FeatureFreshnessStatus;
    oldestFeatureAgeMs: number;
  };
  missingFeatures: string[];
  signalsSummary: {
    worldcoinVerified: boolean;
    walletCount: number;
    tenureDays: number;
    isStaker: boolean;
    claimsEvaluated: number;
  };
  explanation: string;
}

/**
 * DTO for requesting score recomputation
 */
export interface RecomputeScoreOptions {
  pinnedVersion?: string;
  authority?: ChainArtifactAuthority;
  failClosedOnStale?: boolean;
  failClosedOnMissing?: boolean;
  reason?: string;
}

/**
 * DTO for submitting an appeal
 */
export class SybilAppealRequestDto {
  reason!: string;
  scoreId?: string;
  targetModelVersion?: string;
  additionalEvidence?: Record<string, any>;
}

/**
 * Record of an appeal attempt
 */
export interface SybilAppealRecord {
  appealId: string;
  userId: string;
  status: AppealStatus;
  reason: string;
  previousScore: number;
  previousRiskScore: number;
  newScore: number;
  newRiskScore: number;
  modelVersion: string;
  recomputedAt: string;
  provenanceDigest: string;
  additionalEvidenceSummary?: string;
}

/**
 * Domain Exceptions for strict fail-closed boundary enforcement
 */
export class MissingFeatureException extends BadRequestException {
  constructor(message: string) {
    super(`Missing feature: ${message}`);
  }
}

export class StaleFeatureException extends BadRequestException {
  constructor(message: string) {
    super(`Stale feature: ${message}`);
  }
}

export class InvalidFeatureBoundsException extends BadRequestException {
  constructor(message: string) {
    super(`Invalid feature bounds: ${message}`);
  }
}

export class UnauthorizedProvenanceException extends BadRequestException {
  constructor(message: string) {
    super(`Unauthorized provenance: ${message}`);
  }
}

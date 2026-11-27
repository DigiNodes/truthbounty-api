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
 * Status of the canonical claim-history read used for accuracy.
 * `unavailable` means no finalized checkpoint/source could be resolved; it is
 * never equivalent to a verified zero-accuracy history.
 */
export type ClaimAccuracyHistoryStatus = 'finalized' | 'unavailable';

export interface ClaimAccuracyProvenance {
  status: ClaimAccuracyHistoryStatus;
  chainId?: number;
  releaseId?: string;
  verificationContractAddress?: string;
  finalizedThroughBlock?: number;
  observedAt?: string | null;
  canonicalEventCount?: number;
  eligibleEvaluationCount?: number;
  excluded?: Record<string, number>;
  reason?: string;
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
  claimsHistory?: ClaimAccuracyProvenance;
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

/**
 * PREWAVE-BE-150: Sanitized Feature Provenance (strictly redacting sensitiveData)
 */
export interface SanitizedFeatureProvenance {
  featureName:
    | 'worldcoin'
    | 'wallet_age'
    | 'staking'
    | 'accuracy'
    | (string & {});
  source: 'canonical_chain' | 'world_id' | 'wallet_registry' | 'claims_history';
  observedAt: string;
  freshnessMs: number;
  isStale: boolean;
  isMissing: boolean;
  details: Record<string, any>;
  // sensitiveData (nullifierHash, proof, walletAddresses) is strictly EXCLUDED!
}

/**
 * PREWAVE-BE-150: Sanitized Calculation Details
 */
export interface SanitizedCalculationDetails {
  version: string;
  worldcoinWeight?: number;
  walletAgeWeight?: number;
  stakingWeight?: number;
  accuracyWeight?: number;
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
  missingFeatures: string[];
  staleFeatures: string[];
  featureProvenance?: Record<string, SanitizedFeatureProvenance>;
}

/**
 * PREWAVE-BE-150: Dedicated Sanitized Sybil Score Response DTO
 */
export interface SanitizedSybilScoreDto {
  id?: string;
  userId?: string;
  compositeScore: number;
  worldcoinScore?: number;
  walletAgeScore?: number;
  stakingScore?: number;
  accuracyScore?: number;
  createdAt?: Date | string;
  details?: SanitizedCalculationDetails;
}

/**
 * PREWAVE-BE-150: Dedicated Sanitized Sybil Appeal Response DTO
 */
export interface SanitizedSybilAppealDto {
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
  // additionalEvidenceSummary is excluded from public/owner response
}

/**
 * PREWAVE-BE-150: Minimal Voting Engine Response DTO
 */
export interface SybilVotingScoreDto {
  userId: string;
  score: number;
  isVerified: boolean;
}

/**
 * PREWAVE-BE-150: Sanitized Sybil Score Computation Result DTO
 */
export interface SanitizedSybilScoreComputationResult {
  score: number;
  riskScore: number;
  riskLevel: SybilRiskLevel;
  version: string;
  provenanceDigest: string;
  missingFeatures: string[];
  staleFeatures: string[];
  details: SanitizedCalculationDetails;
}
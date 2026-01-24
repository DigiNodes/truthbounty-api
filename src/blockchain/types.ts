/**
 * Core types for blockchain event tracking and reorg handling
 */

export interface BlockInfo {
  number: number;
  hash: string;
  timestamp: number;
  parentHash: string;
}

export interface BlockRecord {
  id: string; // blockNumber:blockHash
  blockNumber: number;
  blockHash: string;
  parentHash: string;
  timestamp: number;
  isCanonical: boolean;
  createdAt: Date;
}

export interface PendingEvent {
  id: string;
  blockNumber: number;
  blockHash: string;
  eventType: string;
  data: Record<string, any>;
  transactionHash: string;
  logIndex: number;
  status: 'pending' | 'confirmed' | 'orphaned';
  confirmations: number;
  createdAt: Date;
  confirmedAt?: Date;
}

export interface ReorgEvent {
  detectedAt: Date;
  reorgDepth: number;
  affectedBlockStart: number;
  affectedBlockEnd: number;
  orphanedEvents: string[]; // event IDs
  reprocessedEvents: string[];
}

export interface ChainState {
  lastProcessedBlock: number;
  lastCanonicalHash: string;
  confirmedDepth: number;
  pendingEventCount: number;
  orphanedEventCount: number;
  lastReorgTime?: Date;
}

/**
 * Verification and Voting Types
 */

export type Verdict = 'TRUE' | 'FALSE' | 'UNSURE';

export interface VerificationVote {
  claimId: string;
  userId: string;
  verdict: Verdict;
  stakeAmount: string; // BigInt as string
  userReputation: number;
  timestamp: Date;
  eventId: string; // Reference to blockchain event
}

export interface WeightedVote {
  claimId: string;
  userId: string;
  verdict: Verdict;
  stakeAmount: string;
  userReputation: number;
  weight: number; // Calculated weight
  timestamp: Date;
}

export interface VoteAggregation {
  claimId: string;
  totalWeight: number;
  verdictWeights: Record<Verdict, number>;
  voterCount: number;
  votes: WeightedVote[];
}

export interface ClaimResolution {
  claimId: string;
  resolvedVerdict: Verdict | 'UNRESOLVED';
  confidenceScore: number; // 0.0 to 1.0
  resolutionMargin: number; // Difference between top two verdicts
  totalWeight: number;
  voterCount: number;
  verdictDistribution: Record<Verdict, number>;
  metadata: {
    timestamp: Date;
    dominantVerdictWeight: number;
    secondVerdictWeight: number;
    isTie: boolean;
    isLowConfidence: boolean;
  };
}

export interface ResolutionConfig {
  minTotalWeight: number; // Minimum weight to resolve
  confidenceThreshold: number; // Minimum confidence (0.0-1.0)
  maxReputationShare: number; // Max % one user can contribute (0.0-1.0)
  tieThreshold: number; // Margin threshold for ties
}

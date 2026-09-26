import { Dispute } from '../../../src/dispute/entities/dispute.entity';
import { createTestWallet, getContractAddress, createMockLog, createMockTransactionReceipt } from './blockchain.fixture';

/**
 * Dispute Contract Test Fixtures
 * Provides mock data for dispute contract interactions and events
 */

// Mock dispute contract ABI events signatures
export const DISPUTE_EVENT_SIGNATURES = {
  DISPUTE_CREATED: 'DisputeCreated(uint256,address,bytes32,string)',
  VOTE_CAST: 'VoteCast(address,uint256,uint8,uint256)',
  DISPUTE_RESOLVED: 'DisputeResolved(uint256,uint8,uint256)',
  APPEAL_CREATED: 'AppealCreated(uint256,uint256)',
  EVIDENCE_SUBMITTED: 'EvidenceSubmitted(uint256,address,string)',
} as const;

// Dispute resolution outcomes
export enum DisputeOutcome {
  PENDING = 0,
  APPROVED = 1,
  REJECTED = 2,
  DRAW = 3,
}

// Vote types
export enum VoteType {
  AGAINST = 0,
  FOR = 1,
  ABSTAIN = 2,
}

/**
 * Mock dispute data
 */
export interface MockDisputeData {
  id?: string;
  claimId: string;
  creatorAddress: string;
  evidenceCID: string;
  description: string;
  createdAt: Date;
  expiresAt: Date;
  totalVotesFor: string;
  totalVotesAgainst: string;
  totalStakeFor: string;
  totalStakeAgainst: string;
  outcome: DisputeOutcome;
  resolvedAt?: Date;
  resolutionBlock?: number;
}

/**
 * Mock vote data
 */
export interface MockVoteData {
  id?: string;
  disputeId: string;
  voterAddress: string;
  vote: VoteType;
  stakeAmount: string;
  createdAt: Date;
  transactionHash: string;
  blockNumber: number;
}

/**
 * Create mock dispute entity
 */
export function createMockDispute(overrides: Partial<MockDisputeData> = {}): Dispute {
  const defaultData: MockDisputeData = {
    claimId: `claim_${Math.random().toString(36).substr(2, 9)}`,
    creatorAddress: createTestWallet('dispute_creator').address,
    evidenceCID: `Qm${Math.random().toString(36).substr(2, 44)}`,
    description: 'Test dispute for claim verification',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    totalVotesFor: '0',
    totalVotesAgainst: '0',
    totalStakeFor: '0',
    totalStakeAgainst: '0',
    outcome: DisputeOutcome.PENDING,
  };

  const disputeData = { ...defaultData, ...overrides };
  
  return {
    id: disputeData.id || `dispute_${Math.random().toString(36).substr(2, 9)}`,
    claimId: disputeData.claimId,
    creatorAddress: disputeData.creatorAddress,
    evidenceCID: disputeData.evidenceCID,
    description: disputeData.description,
    createdAt: disputeData.createdAt,
    expiresAt: disputeData.expiresAt,
    totalVotesFor: disputeData.totalVotesFor,
    totalVotesAgainst: disputeData.totalVotesAgainst,
    totalStakeFor: disputeData.totalStakeFor,
    totalStakeAgainst: disputeData.totalStakeAgainst,
    outcome: disputeData.outcome,
    resolvedAt: disputeData.resolvedAt,
    resolutionBlock: disputeData.resolutionBlock,
    votes: [],
  } as unknown as Dispute;
}

/**
 * Create mock vote
 */
export function createMockVote(
  dispute: Dispute,
  overrides: Partial<MockVoteData> = {}
): any { // Using 'any' to avoid circular dependency issues
  const defaultData: MockVoteData = {
    disputeId: dispute.id,
    voterAddress: createTestWallet().address,
    vote: VoteType.FOR,
    stakeAmount: '1000000000000000000', // 1 ETH
    createdAt: new Date(),
    transactionHash: `0x${Math.random().toString(16).substr(2, 64)}`,
    blockNumber: Math.floor(Math.random() * 1000000),
  };

  const voteData = { ...defaultData, ...overrides };
  
  return {
    id: voteData.id || `vote_${Math.random().toString(36).substr(2, 9)}`,
    disputeId: voteData.disputeId,
    voterAddress: voteData.voterAddress,
    vote: voteData.vote,
    stakeAmount: voteData.stakeAmount,
    createdAt: voteData.createdAt,
    transactionHash: voteData.transactionHash,
    blockNumber: voteData.blockNumber,
  };
}

/**
 * Create multiple mock disputes
 */
export function createMockDisputes(count: number = 3): Dispute[] {
  return Array.from({ length: count }, (_, i) => 
    createMockDispute({
      claimId: `claim_${i + 1}`,
      description: `Dispute for claim ${i + 1}`,
      createdAt: new Date(Date.now() - i * 86400000), // Created 0-2 days ago
      outcome: i === 0 ? DisputeOutcome.APPROVED : 
               i === 1 ? DisputeOutcome.REJECTED : 
               DisputeOutcome.PENDING,
    })
  );
}

/**
 * Create multiple votes for a dispute
 */
export function createMockVotes(dispute: Dispute, count: number = 5): any[] {
  const votes: any[] = [];
  let totalFor = 0n;
  let totalAgainst = 0n;
  let votesFor = 0;
  let votesAgainst = 0;

  for (let i = 0; i < count; i++) {
    const voteType = i < 3 ? VoteType.FOR : VoteType.AGAINST; // 3 for, 2 against
    const stakeAmount = (BigInt(i + 1) * 1000000000000000000n).toString(); // 1, 2, 3, 4, 5 ETH
    
    const vote = createMockVote(dispute, {
      vote: voteType,
      stakeAmount,
    });
    
    votes.push(vote);
    
    if (voteType === VoteType.FOR) {
      totalFor += BigInt(stakeAmount);
      votesFor++;
    } else {
      totalAgainst += BigInt(stakeAmount);
      votesAgainst++;
    }
  }

  // Update dispute totals
  (dispute as any).totalVotesFor = votesFor.toString();
  (dispute as any).totalVotesAgainst = votesAgainst.toString();
  (dispute as any).totalStakeFor = totalFor.toString();
  (dispute as any).totalStakeAgainst = totalAgainst.toString();

  return votes;
}

/**
 * Create mock dispute contract event log
 */
export function createMockDisputeEventLog(
  eventType: string,
  params: any,
  blockNumber: number = 1
) {
  const contractAddress = getContractAddress('DISPUTE');
  let topics: string[];
  let data: string;

  switch (eventType) {
    case 'DisputeCreated':
      topics = [
        DISPUTE_EVENT_SIGNATURES.DISPUTE_CREATED,
        '0x' + Number(params.disputeId).toString(16).padStart(64, '0'),
        '0x' + params.creatorAddress.slice(2).padStart(64, '0'),
        '0x' + params.claimId.padStart(64, '0'),
      ];
      data = '0x' + Buffer.from(params.description).toString('hex').padStart(64, '0');
      break;
      
    case 'VoteCast':
      topics = [
        DISPUTE_EVENT_SIGNATURES.VOTE_CAST,
        '0x' + params.voterAddress.slice(2).padStart(64, '0'),
        '0x' + Number(params.disputeId).toString(16).padStart(64, '0'),
      ];
      data = '0x' + 
        Number(params.vote).toString(16).padStart(64, '0') +
        BigInt(params.stakeAmount).toString(16).padStart(64, '0');
      break;
      
    case 'DisputeResolved':
      topics = [
        DISPUTE_EVENT_SIGNATURES.DISPUTE_RESOLVED,
        '0x' + Number(params.disputeId).toString(16).padStart(64, '0'),
      ];
      data = '0x' + 
        Number(params.outcome).toString(16).padStart(64, '0') +
        BigInt(params.totalStake).toString(16).padStart(64, '0');
      break;
      
    case 'AppealCreated':
      topics = [
        DISPUTE_EVENT_SIGNATURES.APPEAL_CREATED,
        '0x' + Number(params.disputeId).toString(16).padStart(64, '0'),
      ];
      data = '0x' + BigInt(params.appealFee).toString(16).padStart(64, '0');
      break;
      
    case 'EvidenceSubmitted':
      topics = [
        DISPUTE_EVENT_SIGNATURES.EVIDENCE_SUBMITTED,
        '0x' + Number(params.disputeId).toString(16).padStart(64, '0'),
        '0x' + params.submitterAddress.slice(2).padStart(64, '0'),
      ];
      data = '0x' + Buffer.from(params.evidenceCID).toString('hex').padStart(64, '0');
      break;
      
    default:
      throw new Error(`Unknown event type: ${eventType}`);
  }

  return createMockLog(contractAddress, topics, data, blockNumber);
}

/**
 * Create mock dispute transaction receipt with events
 */
export function createMockDisputeTransactionReceipt(
  eventType: string,
  params: any,
  txHash: string,
  blockNumber: number = 1
) {
  const receipt = createMockTransactionReceipt(txHash, blockNumber);
  receipt.logs = [
    createMockDisputeEventLog(eventType, params, blockNumber)
  ];
  return receipt;
}

/**
 * Mock dispute contract state
 */
export interface MockDisputeState {
  totalDisputes: number;
  activeDisputes: number;
  resolvedDisputes: number;
  totalStaked: string;
  disputeMap: Map<string, Dispute>; // disputeId -> dispute
  voteMap: Map<string, any[]>; // disputeId -> votes
}

/**
 * Create mock dispute contract state
 */
export function createMockDisputeState(overrides: Partial<MockDisputeState> = {}): MockDisputeState {
  const defaultState: MockDisputeState = {
    totalDisputes: 15,
    activeDisputes: 8,
    resolvedDisputes: 7,
    totalStaked: '500000000000000000000', // 500 ETH
    disputeMap: new Map(),
    voteMap: new Map(),
  };

  const state = { ...defaultState, ...overrides };
  
  // Add some default disputes if none provided
  if (state.disputeMap.size === 0) {
    const disputes = createMockDisputes(3);
    disputes.forEach(dispute => {
      state.disputeMap.set(dispute.id, dispute);
      state.voteMap.set(dispute.id, createMockVotes(dispute, 4));
    });
  }

  return state;
}
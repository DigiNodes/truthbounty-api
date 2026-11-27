import { GovernanceAction } from '../entities/governance-action.entity';
import {
  GovernanceProposal,
  ProposalChainState,
} from '../entities/governance-proposal.entity';
import { ProposalVote } from '../entities/proposal-vote.entity';

/**
 * A proposal as served by the API. State and ETA come from the persisted
 * entity, which came from chain events — never recomputed here.
 */
export interface GovernanceProposalReadModel {
  chainId: number;
  proposalId: string;
  governorAddress: string;
  proposer: string;
  proposalHash: string;
  description: string | null;
  state: ProposalChainState;
  eta: string | null;
  stateChangedAtBlock: string;
  stateChangedAt: Date | null;
  artifactVersion: string;
  actions: GovernanceActionReadModel[];
  /** Aggregates derived only from stored vote rows. */
  voteTotals: {
    for: string;
    against: string;
    abstain: string;
    voters: number;
  };
}

export interface GovernanceActionReadModel {
  actionIndex: number;
  target: string;
  valueWei: string;
  calldata: string;
  calldataChecksum: string;
  selector: string | null;
  functionSignature: string | null;
  selectorUnknown: boolean;
  decodedArgs: Record<string, unknown> | null;
}

/**
 * One entry in the canonical lifecycle history returned by the timelock
 * endpoint. Kept separate from `state`, which is the proposal's current state.
 */
export interface ProposalTransitionReadModel {
  chainId: number;
  contractAddress: string;
  proposalId: string;
  eventName: string;
  state: ProposalChainState;
  eta: string | null;
  txHash: string;
  logIndex: number;
  blockNumber: string;
  blockTimestamp: Date | null;
  artifactVersion: string;
}

export interface ProposalTimelockReadModel {
  chainId: number;
  proposalId: string;
  eta: string | null;
  /** Current state from the proposal projection (not from history). */
  state: ProposalChainState;
  queuedAtBlock: string | null;
  executedAtBlock: string | null;
  cancelledAtBlock: string | null;
  expiredAtBlock: string | null;
  artifactVersion: string;
  /** Full canonical lifecycle history, ordered by block then log index. */
  transitions: ProposalTransitionReadModel[];
}

export interface RoleChangeReadModel {
  chainId: number;
  contractAddress: string;
  kind: 'GRANTED' | 'REVOKED';
  role: string;
  account: string;
  sender: string;
  txHash: string;
  logIndex: number;
  blockNumber: string;
  blockTimestamp: Date | null;
  artifactVersion: string;
}

export interface GovernanceProposalListResult {
  items: GovernanceProposal[];
  nextCursor: string | null;
}

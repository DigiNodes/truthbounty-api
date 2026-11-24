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

export interface ProposalTimelockReadModel {
  chainId: number;
  proposalId: string;
  eta: string | null;
  state: ProposalChainState;
  queuedAtBlock: string | null;
  executedAtBlock: string | null;
  cancelledAtBlock: string | null;
  expiredAtBlock: string | null;
  artifactVersion: string;
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

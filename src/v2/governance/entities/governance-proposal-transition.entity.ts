import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
  Check,
} from 'typeorm';
import { ProposalChainState } from './governance-proposal.entity';

/**
 * Immutable projection of a single canonical governance lifecycle event.
 *
 * PREWAVE-BE-190: the proposal row only retains its *current* state, so a
 * QUEUED → EXECUTED transition destroys the queued block. This table keeps
 * one append-only row per lifecycle event with the full on-chain provenance
 * (chain, emitting contract, proposal id, transaction, log index, block and
 * artifact version). The timelock read model is built exclusively from these
 * rows, never from the current state or from action-row existence.
 *
 * Reorg rollback removes only the rows above the affected block; replaying
 * canonical events rebuilds them deterministically. Uniqueness on
 * (chainId, txHash, logIndex) makes replay idempotent.
 */
@Entity('v2_governance_proposal_transitions')
@Unique('uq_v2_gov_transition_identity', ['chainId', 'txHash', 'logIndex'])
@Index('idx_v2_gov_transition_proposal', [
  'chainId',
  'proposalId',
  'blockNumber',
  'logIndex',
])
@Index('idx_v2_gov_transition_proposal_event', [
  'chainId',
  'proposalId',
  'eventName',
])
@Check('chk_v2_gov_transition_chain_positive', '"chainId" > 0')
@Check('chk_v2_gov_transition_log_nonneg', '"logIndex" >= 0')
export class GovernanceProposalTransition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Optimism chain ID (10 or 11155420). */
  @Column({ type: 'int' })
  chainId: number;

  /** Address of the Governor contract that emitted the lifecycle event. */
  @Column({ type: 'varchar', length: 42 })
  contractAddress: string;

  /** Numeric proposal ID assigned by the Governor contract. */
  @Column({ type: 'bigint' })
  proposalId: string;

  /** Canonical event name, e.g. `ProposalQueued`. */
  @Column({ type: 'varchar', length: 128 })
  eventName: string;

  /** State represented by this transition (distinct from current state). */
  @Column({ type: 'varchar', default: ProposalChainState.PENDING })
  state: ProposalChainState;

  /** ETA carried by the event, when the event provides one. */
  @Column({ type: 'bigint', nullable: true })
  eta: string | null;

  /** Transaction that emitted the event. */
  @Column({ type: 'varchar', length: 66 })
  txHash: string;

  /** Log index of the event inside the transaction. */
  @Column({ type: 'int' })
  logIndex: number;

  /** Ledger block that produced the event. */
  @Column({ type: 'bigint' })
  blockNumber: string;

  /** Timestamp of the block that produced the event. */
  @Column({ type: Date, nullable: true })
  blockTimestamp: Date | null;

  /** Artifact version that was authoritative when the event was decoded. */
  @Column({ type: 'varchar', length: 64 })
  artifactVersion: string;

  @CreateDateColumn()
  recordedAt: Date;
}

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
  Check,
} from 'typeorm';

/**
 * On-chain proposal state as observed by the chain.
 *
 * This is a pure projection of canonical events emitted by the Governor
 * contract. The API never invents a status — every value here traces back to
 * a `CanonicalEvent` row with a specific `artifactVersion` and block.
 *
 * V2-BE-067 — PREWAVE-BE-067.
 */
export enum ProposalChainState {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  QUEUED = 'QUEUED',
  EXECUTED = 'EXECUTED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

@Entity('v2_governance_proposals')
@Unique('uq_v2_gov_prop_chain_id', ['chainId', 'proposalId'])
@Index(['chainId', 'state'])
@Index(['chainId', 'proposer'])
@Index(['chainId', 'eta'])
@Check('chk_v2_gov_prop_chain_positive', '"chainId" > 0')
@Check('chk_v2_gov_prop_id_nonneg', '"proposalId" >= 0')
export class GovernanceProposal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Optimism chain ID (10 or 11155420). */
  @Column({ type: 'int' })
  chainId: number;

  /** Numeric proposal ID assigned by the Governor contract. */
  @Column({ type: 'bigint' })
  proposalId: string;

  /** Address of the Governor contract that emitted the events. */
  @Column({ type: 'varchar', length: 42 })
  governorAddress: string;

  /** Checksummed proposer address. */
  @Column({ type: 'varchar', length: 42 })
  proposer: string;

  /**
   * Keccak256 hex of the proposal's canonical call description
   * (`targets + values + calldatas + descriptionHash`).
   * Immutable per proposal ID — used to detect overloaded-argument drift.
   */
  @Column({ type: 'varchar', length: 66 })
  proposalHash: string;

  /**
   * Human-readable description as emitted on-chain.
   * Nullable because some Governors emit only the description hash.
   */
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** State derived from the chain. Never computed locally. */
  @Column({ type: 'varchar', default: ProposalChainState.PENDING })
  state: ProposalChainState;

  /**
   * Ready-for-execution timestamp (seconds, as returned by the contract's
   * `proposalEta`). Null until the proposal reaches QUEUED.
   */
  @Column({ type: 'bigint', nullable: true })
  eta: string | null;

  /**
   * Ledger block at which the proposal entered its current state.
   * Set from the event's blockNumber, not from ingestion time.
   */
  @Column({ type: 'bigint' })
  stateChangedAtBlock: string;

  /** Timestamp of the block that produced the current state. */
  @Column({ type: 'datetime', nullable: true })
  stateChangedAt: Date | null;

  /** Artefact version that was authoritative when the last event was decoded. */
  @Column({ type: 'varchar', length: 64 })
  artifactVersion: string;

  /** Transaction hash of the event that produced the current state. */
  @Column({ type: 'varchar', length: 66 })
  lastEventTxHash: string;

  /** Log index of the event that produced the current state. */
  @Column({ type: 'int' })
  lastEventLogIndex: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

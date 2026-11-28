import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum ProposalStatus {
  ACTIVE = 'ACTIVE',
  PASSED = 'PASSED',
  REJECTED = 'REJECTED',
  EXECUTED = 'EXECUTED',
  CANCELLED = 'CANCELLED',
  PENDING = 'PENDING',
}

export enum ProposalCategory {
  PROTOCOL_UPGRADE = 'PROTOCOL_UPGRADE',
  TREASURY = 'TREASURY',
  PARAMETER_CHANGE = 'PARAMETER_CHANGE',
  GOVERNANCE = 'GOVERNANCE',
  COMMUNITY = 'COMMUNITY',
}

/** Distinguishes an off-chain draft from a projection of a canonical log. */
export enum GovernanceRecordKind {
  OFFCHAIN_DRAFT = 'OFFCHAIN_DRAFT',
  CANONICAL = 'CANONICAL',
}

/** Labels the data state so drafts are never presented as protocol truth. */
export enum GovernanceDataState {
  DRAFT = 'DRAFT',
  FINALIZED = 'FINALIZED',
}

@Entity('proposals')
@Index(['status'])
@Index(['category'])
@Index(['proposer'])
@Index(['createdAt'])
@Index(['status', 'category'])
export class Proposal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 500 })
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar' })
  proposer: string;

  @Column({
    type: 'varchar',
    default: ProposalStatus.PENDING,
  })
  status: ProposalStatus;

  @Column({
    type: 'varchar',
    default: ProposalCategory.PROTOCOL_UPGRADE,
  })
  category: ProposalCategory;

  /**
   * Never set from a request body. Present only when the row was projected
   * from a validated canonical ProposalCreated event.
   */
  @Column({ type: 'varchar', nullable: true })
  blockchainTxHash: string | null;

  @Column({
    type: 'varchar',
    default: GovernanceRecordKind.OFFCHAIN_DRAFT,
  })
  recordKind: GovernanceRecordKind;

  @Column({ type: 'varchar', default: GovernanceDataState.DRAFT })
  dataState: GovernanceDataState;

  @Column({ type: 'int', nullable: true })
  chainId: number | null;

  @Column({ type: 'varchar', length: 42, nullable: true })
  governorAddress: string | null;

  @Column({ type: 'varchar', nullable: true })
  canonicalProposalId: string | null;

  @Column({ type: 'int', nullable: true })
  creationLogIndex: number | null;

  @Column({ type: 'varchar', nullable: true })
  creationBlockNumber: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  artifactVersion: string | null;

  @Column({ type: 'varchar', length: 78, default: '0' })
  voteWeightFor: string;

  @Column({ type: 'varchar', length: 78, default: '0' })
  voteWeightAgainst: string;

  @Column({ type: 'varchar', length: 78, default: '0' })
  voteWeightAbstain: string;

  @Column({ type: 'int', default: 0 })
  totalVotes: number;

  @Column({ type: 'int', default: 0 })
  votesFor: number;

  @Column({ type: 'int', default: 0 })
  votesAgainst: number;

  @Column({ type: 'decimal', precision: 5, scale: 4, default: 0 })
  participationRate: number;

  @Column({ type: 'decimal', precision: 5, scale: 4, default: 0 })
  quorumProgress: number;

  @Column({ type: 'datetime', nullable: true })
  votingStartsAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  votingEndsAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  executedAt: Date | null;

  @Column({ type: 'simple-json', default: {} })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

export enum VoteSupportMode {
  FOR = 'FOR',
  AGAINST = 'AGAINST',
  ABSTAIN = 'ABSTAIN',
}

@Entity('votes')
@Index(['proposalId'])
@Index(['voter'])
@Index(['proposalId', 'voter'], { unique: true })
@Index(
  ['chainId', 'governorAddress', 'canonicalProposalId', 'voter', 'txHash', 'logIndex'],
  { unique: true },
)
export class Vote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  proposalId: string;

  @Column()
  voter: string;

  @Column({ type: 'boolean' })
  support: boolean;

  /** FOR / AGAINST / ABSTAIN as emitted by the canonical event. */
  @Column({ type: 'varchar', length: 16, default: VoteSupportMode.FOR })
  supportMode: VoteSupportMode;

  /** Exact uint256 weight as a decimal string, never a client-supplied number. */
  @Column({ type: 'varchar', length: 78, default: '0' })
  weight: string;

  @Column({ type: 'int', nullable: true })
  chainId: number | null;

  @Column({ type: 'varchar', length: 42, nullable: true })
  governorAddress: string | null;

  @Column({ type: 'varchar', nullable: true })
  canonicalProposalId: string | null;

  @Column({ type: 'varchar', length: 66, nullable: true })
  txHash: string | null;

  @Column({ type: 'int', nullable: true })
  logIndex: number | null;

  @Column({ type: 'varchar', nullable: true })
  blockNumber: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  artifactVersion: string | null;

  @Column({ type: 'varchar', default: GovernanceDataState.FINALIZED })
  dataState: GovernanceDataState;

  @Column({ type: 'simple-json', default: {} })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;
}

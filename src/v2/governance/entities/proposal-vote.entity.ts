import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
  Check,
} from 'typeorm';

export enum VoteSupport {
  AGAINST = 'AGAINST',
  FOR = 'FOR',
  ABSTAIN = 'ABSTAIN',
}

/**
 * One vote on a proposal, decoded from a canonical `VoteCast` event.
 *
 * Idempotent by (chainId, proposalId, voter, txHash, logIndex) — a vote
 * can never be double-inserted across reorg replays.
 */
@Entity('v2_governance_votes')
@Unique('uq_v2_gov_vote_log', ['chainId', 'txHash', 'logIndex'])
@Index(['chainId', 'proposalId'])
@Index(['chainId', 'voter'])
@Check('chk_v2_gov_vote_prop_nonneg', '"proposalId" >= 0')
export class ProposalVote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  chainId: number;

  @Column({ type: 'bigint' })
  proposalId: string;

  /** Checksummed voter address. */
  @Column({ type: 'varchar', length: 42 })
  voter: string;

  @Column({ type: 'varchar' })
  support: VoteSupport;

  /** Raw vote weight as emitted on-chain, as a decimal string. */
  @Column({ type: 'varchar', length: 78 })
  weight: string;

  /** Optional on-chain reason string. */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'varchar', length: 66 })
  txHash: string;

  @Column({ type: 'int' })
  logIndex: number;

  @Column({ type: 'bigint' })
  blockNumber: string;

  @Column({ type: 'datetime', nullable: true })
  blockTimestamp: Date | null;

  /** Artefact version used to decode this vote. */
  @Column({ type: 'varchar', length: 64 })
  artifactVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}

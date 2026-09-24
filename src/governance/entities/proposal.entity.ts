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

  @Column({ type: 'varchar', nullable: true })
  blockchainTxHash: string | null;

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

@Entity('votes')
@Index(['proposalId'])
@Index(['voter'])
@Index(['proposalId', 'voter'], { unique: true })
export class Vote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  proposalId: string;

  @Column()
  voter: string;

  @Column({ type: 'boolean' })
  support: boolean;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  weight: number;

  @Column({ type: 'simple-json', default: {} })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;
}

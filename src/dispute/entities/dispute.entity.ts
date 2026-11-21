import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum DisputeStatus {
  OPEN = 'OPEN',
  REVIEWING = 'REVIEWING',
  RESOLVED = 'RESOLVED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

export enum DisputeOutcome {
  CONFIRMED = 'CONFIRMED', // Original claim outcome stands
  OVERTURNED = 'OVERTURNED', // Claim outcome reversed
}

export enum DisputeTrigger {
  LOW_CONFIDENCE = 'LOW_CONFIDENCE',
  MINORITY_OPPOSITION = 'MINORITY_OPPOSITION',
  MANUAL = 'MANUAL',
}

/** Whether the row is local workflow metadata or a canonical chain projection. */
export enum DisputeRecordKind {
  LEGACY_WORKFLOW = 'LEGACY_WORKFLOW',
  CANONICAL_PROJECTION = 'CANONICAL_PROJECTION',
}

/** Labels the data state so workflow rows are never presented as protocol truth. */
export enum DisputeDataState {
  LOCAL_WORKFLOW = 'LOCAL_WORKFLOW',
  FINALIZED = 'FINALIZED',
}

@Entity('disputes')
@Index(['claimId'])
@Index(['status'])
@Index(['createdAt'])
@Index(['claimId', 'status'])
@Index(['chainId', 'eventTxHash', 'eventLogIndex'], {
  unique: true,
  where: '"eventTxHash" IS NOT NULL',
})
export class Dispute {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  claimId: string;

  @Column({
    type: 'varchar',
    default: DisputeStatus.OPEN,
  })
  status: DisputeStatus;

  @Column({
    type: 'varchar',
  })
  trigger: DisputeTrigger;

  @Column('decimal', { precision: 5, scale: 2 })
  originalConfidence: number;

  @Column('decimal', { precision: 5, scale: 2, nullable: true })
  finalConfidence: number | null;

  @Column({
    type: 'varchar',
    nullable: true,
  })
  outcome: DisputeOutcome | null;

  /**
   * Always the verified JWT principal. Legacy callers may still send an
   * `initiatorId`, but the server never persists that client-supplied value.
   */
  @Column({ nullable: true })
  initiatorId: string;

  /** Distinguishes non-authoritative workflow rows from canonical projections. */
  @Column({
    type: 'varchar',
    default: DisputeRecordKind.LEGACY_WORKFLOW,
  })
  recordKind: DisputeRecordKind;

  @Column({ type: 'varchar', default: DisputeDataState.LOCAL_WORKFLOW })
  dataState: DisputeDataState;

  /** Provenance of the latest canonical event projected into this row. */
  @Column({ type: 'int', nullable: true })
  chainId: number | null;

  @Column({ type: 'varchar', length: 42, nullable: true })
  deploymentAddress: string | null;

  /** Approved release artifact version — the protocol "release" binding. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  artifactVersion: string | null;

  @Column({ type: 'varchar', length: 66, nullable: true })
  canonicalClaimId: string | null;

  @Column({ type: 'varchar', length: 66, nullable: true })
  originalRoundId: string | null;

  @Column({ type: 'varchar', length: 66, nullable: true })
  eventTxHash: string | null;

  @Column({ type: 'int', nullable: true })
  eventLogIndex: number | null;

  @Column({ type: 'varchar', length: 78, nullable: true })
  eventBlockNumber: string | null;

  @Column('simple-json', { default: {} })
  metadata: Record<string, any>;

  @Column({ type: 'datetime', nullable: true })
  reviewStartedAt: Date;

  @Column({ type: 'datetime', nullable: true })
  resolvedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';

export enum RoundType {
  FIRST = 'first',
  APPEAL = 'appeal',
}

export enum RoundStatus {
  OPEN = 'open',
  CLOSED = 'closed',
  RESOLVED = 'resolved',
}

/**
 * A single verification round for a claim. First-round and appeal-round
 * records are isolated by `roundType` + a per-type `roundNumber` sequence,
 * per V2-BE-014's AC, rather than sharing one undifferentiated sequence --
 * an appeal round is a distinct kind of record, not "round 2" of the same
 * kind.
 */
@Entity('v2_project_verification_round')
@Unique('uq_v2_round_sequence', ['claimId', 'roundType', 'roundNumber'])
@Index(['claimId'])
export class ProjectVerificationRound {
  /** Opaque protocol round id, taken verbatim from the event. */
  @PrimaryColumn({ type: 'varchar', length: 66 })
  roundId: string;

  @Column({ type: 'varchar', length: 66 })
  claimId: string;

  @Column({ type: 'varchar', length: 16 })
  roundType: RoundType;

  /** Sequence number within this claim + roundType (1, 2, 3, ...). */
  @Column({ type: 'int' })
  roundNumber: number;

  @Column({ type: Date, nullable: true })
  deadline: Date | null;

  @Column({ type: 'varchar', length: 16, default: RoundStatus.OPEN })
  status: RoundStatus;

  @Column({ type: 'bigint' })
  openedAtBlock: string;

  @Column({ type: 'varchar', length: 66 })
  eventTxHash: string;

  @Column({ type: 'int' })
  eventLogIndex: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

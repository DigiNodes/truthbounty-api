import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
  Check,
} from 'typeorm';
import { DataState } from '../../common/data-state.enum';

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
@Unique('uq_v2_round_event', ['eventTxHash', 'eventLogIndex'])
@Index(['claimId'])
@Check('chk_v2_round_number_positive', '"roundNumber" > 0')
@Check('chk_v2_round_block_nonneg', '"openedAtBlock" >= 0')
@Check('chk_v2_round_log_nonneg', '"eventLogIndex" >= 0')
@Check('chk_v2_round_type', "\"roundType\" IN ('first','appeal')")
@Check('chk_v2_round_status', "\"status\" IN ('open','closed','resolved')")
@Check(
  'chk_v2_round_data_state',
  "\"dataState\" IN ('observed','safe','finalized')",
)
@Check(
  'chk_v2_round_ids_present',
  'length("roundId") > 0 AND length("claimId") > 0 AND length("eventTxHash") = 66',
)
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

  @Column({ type: 'varchar', length: 16, default: DataState.OBSERVED })
  dataState: DataState;

  /** Aggregate weights for this round, stored verbatim from contract events */
  @Column({ type: 'varchar', length: 100, nullable: true })
  totalStake: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  totalEffectiveWeight: string | null;

  /** Snapshot of round state at closure, stored verbatim from contract */
  @Column({ type: 'json', nullable: true })
  roundSnapshot: Record<string, unknown> | null;

  /** Appeal deadline if this is an appeal round */
  @Column({ type: 'Date', nullable: true })
  appealDeadline: Date | null;

  @Column({ type: 'varchar', length: 66 })
  eventTxHash: string;

  @Column({ type: 'int' })
  eventLogIndex: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

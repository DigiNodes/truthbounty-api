import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
  Check,
} from 'typeorm';
import { DataState } from '../../common/data-state.enum';

/**
 * One participant's committed position in a verification round.
 *
 * Stake, reputation input, and effective weight are stored verbatim from
 * the event -- this table never recomputes them -- since reimplementing
 * protocol outcome logic in the API is an explicit non-goal of this issue.
 * All three are decimal strings, never floating point.
 */
@Entity('v2_project_participant_position', {
  foreignKeys: [
    {
      columnNames: ['roundId'],
      referencedTableName: 'v2_project_verification_round',
      referencedColumnNames: ['roundId'],
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
  ],
})
@Unique('uq_v2_position_event', ['eventTxHash', 'eventLogIndex'])
@Unique('uq_v2_position_participant_round', ['roundId', 'participant'])
@Index(['roundId'])
@Check(
  'chk_v2_position_data_state',
  `"dataState" IN ('observed', 'safe', 'finalized')`,
@Check('chk_v2_position_block_nonneg', '"blockNumber" >= 0')
@Check('chk_v2_position_log_nonneg', '"eventLogIndex" >= 0')
@Check(
  'chk_v2_position_data_state',
  "\"dataState\" IN ('observed','safe','finalized')",
)
@Check(
  'chk_v2_position_ids_present',
  'length("roundId") > 0 AND length("participant") > 0 AND length("stake") > 0 AND length("eventTxHash") = 66',
)
export class ProjectParticipantPosition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 66 })
  roundId: string;

  @Column({ type: 'varchar', length: 42 })
  participant: string;

  @Column({ type: 'varchar', length: 100 })
  stake: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  reputationInput: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  effectiveWeight: string | null;

  /** Verbatim protocol-encoded verdict/side, not interpreted by the API. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  position: string | null;

  @Column({ type: 'varchar', length: 66 })
  eventTxHash: string;

  @Column({ type: 'int' })
  eventLogIndex: number;

  @Column({ type: 'bigint' })
  blockNumber: string;

  @Column({ type: 'varchar', length: 16, default: DataState.OBSERVED })
  dataState: DataState;

  @CreateDateColumn()
  createdAt: Date;
}

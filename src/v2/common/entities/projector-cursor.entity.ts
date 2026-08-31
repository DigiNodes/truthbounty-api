import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

/**
 * Tracks how far a given V2 projector (evidence, verification, disputes...)
 * has consumed the canonical event stream, so a restart resumes from where
 * it left off instead of re-scanning from genesis or losing its place.
 *
 * Applying each canonical event is additionally guarded by a unique
 * constraint on (eventTxHash, eventLogIndex) in the projector's own tables,
 * so advancing this cursor is a resumption optimization, not the sole
 * idempotency mechanism.
 */
@Entity('v2_projector_cursors')
export class ProjectorCursor {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  projectorName: string;

  @Column({ type: 'bigint', default: 0 })
  lastBlockNumber: string;

  @Column({ type: 'int', default: -1 })
  lastLogIndex: number;

  @UpdateDateColumn()
  updatedAt: Date;
}

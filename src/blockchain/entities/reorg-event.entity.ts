import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Persisted record of every detected chain reorganization.
 *
 * This table serves as the audit trail for operational alerts and post-mortem
 * analysis. It is written inside the same transaction as the rollback so the
 * reorg record is never orphaned from the state it describes.
 */
@Entity('reorg_events')
@Index(['detectedAt'])
@Index(['affectedBlockStart', 'affectedBlockEnd'])
export class ReorgEventRecord {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * Block-hash divergence depth — how many blocks are affected by the reorg.
   */
  @Column({ name: 'reorg_depth', type: 'int' })
  reorgDepth: number;

  /**
   * First block number in the affected range (inclusive).
   */
  @Column({ name: 'affected_block_start', type: 'bigint' })
  affectedBlockStart: number;

  /**
   * Last block number in the affected range (inclusive).
   */
  @Column({ name: 'affected_block_end', type: 'bigint' })
  affectedBlockEnd: number;

  /**
   * Number of orphaned events that were rolled back.
   */
  @Column({ name: 'orphaned_event_count', type: 'int' })
  orphanedEventCount: number;

  /**
   * Number of events re-indexed from the canonical chain after rollback.
   */
  @Column({ name: 'replayed_event_count', type: 'int', default: 0 })
  replayedEventCount: number;

  /**
   * The canonical block hash at the divergence point after re-indexing,
   * confirming the chain is now consistent. Nullable until replay completes.
   */
  @Column({ name: 'canonical_hash_after_replay', type: 'varchar', length: 66, nullable: true })
  canonicalHashAfterReplay: string | null;

  /**
   * Whether the rollback + replay completed successfully.
   */
  @Column({ name: 'completed_successfully', type: 'boolean', default: false })
  completedSuccessfully: boolean;

  /**
   * Error message if the reorg handling failed.
   */
  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  /**
   * Duration of the rollback + replay in milliseconds.
   */
  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs: number | null;

  @CreateDateColumn({ name: 'detected_at' })
  detectedAt: Date;
}

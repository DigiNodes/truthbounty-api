import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import {
  RebuildCheckpoint,
  RebuildStatus,
  serializeCheckpoint,
} from '../rebuild-checkpoint';

/**
 * Durable record of one projection-rebuild attempt.
 *
 * This is the **audit and checkpoint** row. The deterministic part of a rebuild
 * — the counts, the per-projection breakdown, and the input digest — is stored
 * twice: as individual columns so it is queryable and alertable, and as the
 * serialised {@link RebuildCheckpoint} in {@link checkpointJson} so an operator
 * can reproduce the exact report without re-deriving it.
 *
 * The deliberately non-deterministic fields (status transitions, timings,
 * errors) live here and *not* in the checkpoint, which is what allows two
 * rebuilds of the same data to be compared byte for byte.
 */
@Entity('v2_projection_rebuild_runs')
@Index(['chainId', 'status'])
export class ProjectionRebuildRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  chainId: number;

  @Column({ type: 'varchar', length: 16 })
  status: RebuildStatus;

  /**
   * The schema/namespace this rebuild was pointed at. Normally a **shadow**
   * schema, never the live one — see `ProjectionRebuildService`'s guard and
   * `docs/PROJECTION_REBUILD.md`. Null means "the live schema", which is only
   * reachable when the operator explicitly passed `allowInPlace`.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  targetSchema: string | null;

  @Column({ type: 'varchar', length: 32 })
  deploymentBlock: string;

  @Column({ type: 'varchar', length: 32 })
  fromBlock: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  toBlock: string | null;

  @Column({ type: 'varchar', length: 64 })
  inputDigest: string;

  @Column({ type: 'int', default: 0 })
  batchesProcessed: number;

  @Column({ type: 'int', default: 0 })
  eventsConsumed: number;

  @Column({ type: 'int', default: 0 })
  eventsApplied: number;

  @Column({ type: 'int', default: 0 })
  eventsSkipped: number;

  @Column({ type: 'int', default: 0 })
  anomalies: number;

  @Column({ type: 'boolean', default: false })
  safeToCutover: boolean;

  /** The full deterministic report, serialised with sorted keys. */
  @Column({ type: 'text' })
  checkpointJson: string;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn()
  startedAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'datetime', nullable: true })
  finishedAt: Date | null;
}

/** Column projection used when writing a checkpoint onto a run row. */
export type CheckpointColumns = Pick<
  ProjectionRebuildRun,
  | 'status'
  | 'deploymentBlock'
  | 'fromBlock'
  | 'toBlock'
  | 'inputDigest'
  | 'batchesProcessed'
  | 'eventsConsumed'
  | 'eventsApplied'
  | 'eventsSkipped'
  | 'anomalies'
  | 'safeToCutover'
  | 'checkpointJson'
>;

export function checkpointColumns(
  checkpoint: RebuildCheckpoint,
  status: RebuildStatus,
): CheckpointColumns {
  return {
    status,
    deploymentBlock: checkpoint.deploymentBlock,
    fromBlock: checkpoint.fromBlock,
    toBlock: checkpoint.toBlock,
    inputDigest: checkpoint.inputDigest,
    batchesProcessed: checkpoint.batchesProcessed,
    eventsConsumed: checkpoint.eventsConsumed,
    eventsApplied: checkpoint.eventsApplied,
    eventsSkipped: checkpoint.eventsSkipped,
    anomalies: checkpoint.anomalies,
    safeToCutover: checkpoint.safeToCutover,
    // Sorted-key serialisation, so two structurally equal checkpoints produce
    // byte-identical columns and the column can be diffed directly.
    checkpointJson: serializeCheckpoint(checkpoint),
  };
}

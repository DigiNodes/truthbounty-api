import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
  Check,
} from 'typeorm';

export enum IndexingAnomalyKind {
  DUPLICATE_EVENT = 'duplicate_event',
  OUT_OF_ORDER = 'out_of_order',
  INVALID_TRANSITION = 'invalid_transition',
}

/**
 * Append-only record of replay anomalies detected by V2 projectors
 * (duplicate deliveries, out-of-order arrivals, rejected state transitions).
 *
 * This table never blocks ingestion: an anomaly is recorded and the
 * offending event is skipped by the projector, so replay stays safe and
 * observable without a manual intervention step. Sourced by module name so
 * V2-BE-014 and V2-BE-016 (and any future projector) share one queryable
 * audit surface instead of duplicating this table per module.
 */
@Entity('v2_indexing_anomalies')
@Index(['sourceModule', 'kind'])
@Index(['aggregateId'])
@Unique('uq_v2_anomaly_identity', [
  'sourceModule',
  'kind',
  'aggregateId',
  'eventTxHash',
  'eventLogIndex',
])
@Check('chk_v2_anomaly_log_nonneg', '"eventLogIndex" >= 0')
@Check(
  'chk_v2_anomaly_kind',
  "\"kind\" IN ('duplicate_event','out_of_order','invalid_transition')",
)
@Check(
  'chk_v2_anomaly_ids_present',
  'length("sourceModule") > 0 AND length("aggregateId") > 0 AND length("eventTxHash") = 66',
)
export class IndexingAnomaly {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64 })
  sourceModule: string;

  @Column({ type: 'varchar', length: 32 })
  kind: IndexingAnomalyKind;

  /** Domain aggregate the anomaly relates to (round id, dispute id, etc). */
  @Column({ type: 'varchar', length: 128 })
  aggregateId: string;

  @Column({ type: 'varchar', length: 66 })
  eventTxHash: string;

  @Column({ type: 'int' })
  eventLogIndex: number;

  @Column({ type: 'text' })
  detail: string;

  @CreateDateColumn()
  detectedAt: Date;
}

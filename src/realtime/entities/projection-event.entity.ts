import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { ProjectionEventType } from '../realtime.enums';

/**
 * Durably records a normalized projection change (the realtime "outbox").
 *
 * Rows are written within the same database transaction as the projection
 * change itself, so they only become visible to consumers after that
 * transaction commits. This is what guarantees that no projection change is
 * published to the realtime stream before its database transaction commits.
 *
 * The monotonically increasing `id` doubles as the replay/resume cursor: a
 * client resuming with a cursor simply reads rows with `id > cursor`, deterministically
 * and in publish order.
 */
@Entity('projection_events')
@Index('IDX_projection_events_published_id', ['published', 'id'])
@Index('IDX_projection_events_aggregate', ['aggregateType', 'aggregateId'])
@Index('IDX_projection_events_revision', ['revision'])
export class ProjectionEvent {
  @PrimaryGeneratedColumn('increment')
  id: number;

  /**
   * High-level aggregate/domain the projection belongs to (e.g. 'claim', 'reward').
   */
  @Column({ type: 'varchar', length: 128 })
  aggregateType: string;

  /**
   * Identifier of the specific aggregate within its type.
   */
  @Column({ type: 'varchar', length: 128 })
  aggregateId: string;

  /**
   * Kind of projection change: created, updated, or a rollback/replacement.
   */
  @Column({ type: 'varchar', length: 32 })
  eventType: ProjectionEventType;

  /**
   * Normalized, serialized projection payload.
   */
  @Column({ type: 'simple-json' })
  payload: Record<string, any>;

  /**
   * Whether this projection change is considered finalized (reorg-safe).
   * A change emitted while non-finalized may later be superseded by a
   * rollback/replacement envelope.
   */
  @Column({ type: 'boolean', default: false })
  finalized: boolean;

  /**
   * Whether the realtime publisher has successfully broadcast this row.
   * Rows left unpublished are retried (bounded) on subsequent publish passes.
   */
  @Column({ type: 'boolean', default: false })
  published: boolean;

  /**
   * Timestamp when the publisher successfully broadcast this row.
   */
  @Column({ type: 'datetime', nullable: true })
  publishedAt: Date | null;

  /**
   * Correlation identifier so rollback envelopes can reference the original
   * (e.g. the reorged event's transaction hash).
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  correlationId: string | null;

  /**
   * Hardening: nonce to detect and reject duplicate publish attempts for the same cursor.
   */
  @Column({ type: 'bigint', default: 0 })
  revision: number;

  /**
   * Creation timestamp.
   */
  @CreateDateColumn()
  createdAt: Date;
}

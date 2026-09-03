import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ClaimLifecycleEventType } from '../../domain/claim/canonical-claim-event';

/**
 * Persisted, replay-safe log of every observed claim lifecycle event.
 *
 * `eventIndex` + `txHash` + `logIndex` form the idempotency key: the projector
 * replays these in (blockNumber, eventIndex) order, skipping duplicates, so
 * re-ingestion and reorg replays are safe.
 */
@Entity('claim_lifecycle_events')
@Index(['claimId', 'blockNumber', 'eventIndex'], { unique: true })
@Index(['claimId'])
@Index(['chainId'])
@Index(['type'])
@Index(['blockNumber'])
export class ClaimLifecycleEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Canonical lifecycle event type */
  @Column({ type: 'varchar', length: 64 })
  type: ClaimLifecycleEventType;

  /** On-chain claim id */
  @Column({ type: 'varchar', length: 128 })
  claimId: string;

  /** Originating chain */
  @Column({ type: 'varchar', length: 32 })
  chainId: string;

  /** Block height the event was observed at */
  @Column({ type: 'bigint' })
  blockNumber: string;

  /** Sequential index of the event within (claimId) history */
  @Column({ type: 'int' })
  eventIndex: number;

  /** Index of the log within its transaction */
  @Column({ type: 'int' })
  logIndex: number;

  /** Transaction hash the event was emitted in */
  @Column({ type: 'varchar', length: 128 })
  txHash: string;

  /** Emitting account */
  @Column({ type: 'varchar', length: 128, nullable: true })
  actor: string | null;

  /** Contract-encoded payload (opaque) */
  @Column({ type: 'json', nullable: true })
  payload: Record<string, unknown> | null;

  /** Block timestamp of emission */
  @Column({ type: 'timestamp' })
  blockTimestamp: Date;

  @CreateDateColumn()
  createdAt: Date;
}

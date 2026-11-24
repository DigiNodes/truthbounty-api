import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';

export enum WebhookDeliveryStatus {
  PENDING = 'PENDING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  EXHAUSTED = 'EXHAUSTED',
}

/**
 * Per-attempt audit record for an outbound webhook delivery.
 *
 * The combination of `deliveryId` and `attempt` is unique, and `deliveryId`
 * is derived deterministically from the logical event so retries and duplicate
 * enqueues share a stable identity.
 */
@Entity('webhook_deliveries')
@Unique(['deliveryId', 'attempt'])
@Index(['endpointId'])
@Index(['status'])
export class WebhookDeliveryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Stable identity for the logical event (shared across retries). */
  @Column({ type: 'varchar', length: 128 })
  deliveryId: string;

  @Column({ type: 'varchar', length: 128 })
  endpointId: string;

  @Column({ type: 'varchar', length: 255 })
  eventType: string;

  /** Attempt number starting at 1. */
  @Column({ type: 'int' })
  attempt: number;

  @Column({ type: 'varchar', default: WebhookDeliveryStatus.PENDING })
  status: WebhookDeliveryStatus;

  @Column({ type: 'int', nullable: true })
  responseStatus: number | null;

  @Column({ type: 'text', nullable: true })
  responseBody: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  /** Hmac signature sent with this attempt (for audit). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  signature: string | null;

  @Column({ type: 'int', nullable: true })
  secretVersion: number | null;

  /** Timestamp embedded in the signed envelope (Unix seconds). */
  @Column({ type: 'bigint', nullable: true })
  timestamp: string | null;

  @Column({ type: 'int', nullable: true })
  durationMs: number | null;

  /** Next scheduled retry (if any). */
  @Column({ type: 'timestamp', nullable: true })
  nextRetryAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum WebhookEndpointStatus {
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
  REVOKED = 'REVOKED',
}

/**
 * Registered outbound webhook endpoint.
 *
 * Holds the signing secret and the current/previous key versions so that key
 * rotation can be performed without invalidating in-flight deliveries. The
 * `secret` is never returned to clients after creation.
 */
@Entity('webhook_endpoints')
@Index(['status'])
export class WebhookEndpointEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  url: string;

  /** Owner (user/org) that registered the endpoint. */
  @Column({ type: 'varchar', nullable: true })
  ownerId: string | null;

  /** Current signing secret (HMAC-SHA256). */
  @Column({ type: 'varchar', length: 255 })
  secret: string;

  /** Monotonically increasing key version for rotation. */
  @Column({ type: 'int', default: 1 })
  secretVersion: number;

  /** Previous secret retained during rotation grace window. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  previousSecret: string | null;

  @Column({ type: 'int', nullable: true })
  previousSecretVersion: number | null;

  /** When the previous secret stops being accepted. */
  @Column({ type: 'timestamp', nullable: true })
  previousSecretExpiresAt: Date | null;

  @Column({ type: 'varchar', default: WebhookEndpointStatus.ACTIVE })
  status: WebhookEndpointStatus;

  /** Event types this endpoint subscribes to. Empty means all. */
  @Column({ type: 'simple-array', array: true, default: '{}' })
  eventTypes: string[];

  /** Maximum number of delivery attempts before giving up. */
  @Column({ type: 'int', default: 5 })
  maxAttempts: number;

  /** Request timeout in milliseconds. */
  @Column({ type: 'int', default: 10000 })
  timeoutMs: number;

  /** Optional static Headers sent with every delivery. */
  @Column({ type: 'jsonb', nullable: true })
  headers: Record<string, string> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

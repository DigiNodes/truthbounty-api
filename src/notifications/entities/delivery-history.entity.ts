import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { Notification } from './notification.entity';
import {
  DeliveryChannel,
  DeliveryStatus,
} from '../interfaces/notification.types';

/**
 * Durable idempotency claim plus delivery audit row.
 *
 * `idempotencyKey` is unique, so the database — not Redis and not the queue —
 * is the correctness boundary for one notification/recipient/channel delivery.
 */
@Entity('delivery_history')
@Index(['status', 'claimExpiresAt'])
export class DeliveryHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  notificationId: string;

  @ManyToOne(() => Notification, { onDelete: 'CASCADE' })
  notification: Notification;

  @Column({ nullable: true })
  recipientId?: string;

  @Column({ nullable: true })
  eventType?: string;

  @Column({ nullable: true })
  aggregateId?: string;

  @Column({
    type: 'varchar',
    length: 20,
  })
  channel: DeliveryChannel;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'pending',
  })
  status: DeliveryStatus;

  @Column({ type: 'int', default: 0 })
  retryAttempts: number;

  @Column({ nullable: true })
  lastRetryAt: Date;

  @Column({ nullable: true })
  nextAttemptAt?: Date;

  @Column({ nullable: true })
  deliveredAt: Date;

  @Column({ nullable: true })
  failureReason: string;

  @Column({ type: 'boolean', default: false })
  providerUnconfirmed: boolean;

  /** Fencing token: only the worker holding this token may settle the claim. */
  @Column({ nullable: true })
  claimId?: string;

  @Column({ nullable: true })
  claimedAt?: Date;

  @Column({ nullable: true })
  claimExpiresAt?: Date;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @Column({ nullable: true, unique: true })
  idempotencyKey: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

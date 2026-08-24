import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Webhook } from './webhook.entity';

export enum DeliveryStatus {
  PENDING = 'PENDING',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  DEAD_LETTER = 'DEAD_LETTER',
}

@Entity('webhook_deliveries')
@Index(['webhookId'])
@Index(['status'])
@Index(['createdAt'])
@Index(['webhookId', 'status'])
export class WebhookDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  webhookId: string;

  @ManyToOne(() => Webhook, (webhook) => webhook.deliveries, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'webhookId' })
  webhook: Webhook;

  @Column()
  eventType: string;

  @Column({ type: 'json' })
  payload: Record<string, any>;

  @Column({ type: 'varchar', default: DeliveryStatus.PENDING })
  status: DeliveryStatus;

  @Column({ nullable: true })
  responseStatus: number;

  @Column({ type: 'text', nullable: true })
  responseBody: string;

  @Column({ nullable: true })
  latency: number;

  @Column({ default: 0 })
  retryCount: number;

  @Column()
  maxRetries: number;

  @Column({ type: 'text', nullable: true })
  failureReason: string | null;

  @Column()
  requestId: string;

  @Column()
  nonce: string;

  @Column()
  signature: string;

  @Column()
  timestamp: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'datetime', nullable: true })
  completedAt: Date | null;
}

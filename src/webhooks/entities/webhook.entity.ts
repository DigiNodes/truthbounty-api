import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { WebhookSubscription } from './webhook-subscription.entity';
import { WebhookDelivery } from './webhook-delivery.entity';

export enum WebhookEventType {
  CLAIM_CREATED = 'claim.created',
  CLAIM_UPDATED = 'claim.updated',
  VERIFICATION_STARTED = 'verification.started',
  VERIFICATION_COMPLETED = 'verification.completed',
  DISPUTE_CREATED = 'dispute.created',
  DISPUTE_RESOLVED = 'dispute.resolved',
  REWARD_DISTRIBUTED = 'reward.distributed',
  GOVERNANCE_CREATED = 'governance.created',
  GOVERNANCE_EXECUTED = 'governance.executed',
  REPUTATION_UPDATED = 'reputation.updated',
  TREASURY_UPDATED = 'treasury.updated',
  STAKING_UPDATED = 'staking.updated',
}

export const ALL_WEBHOOK_EVENTS: WebhookEventType[] = Object.values(WebhookEventType);

@Entity('webhooks')
@Index(['ownerId'])
@Index(['enabled'])
export class Webhook {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  url: string;

  @Column({ nullable: true })
  description: string;

  @Column()
  ownerId: string;

  @Column({ default: true })
  enabled: boolean;

  @Column()
  secret: string;

  @Column({ type: 'datetime', nullable: true })
  secretExpiresAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  previousSecret: string | null;

  @Column({ type: 'datetime', nullable: true })
  previousSecretExpiresAt: Date | null;

  @Column({ default: 0 })
  consecutiveFailures: number;

  @Column({ default: 3 })
  maxRetries: number;

  @Column({ default: 30000 })
  retryIntervalMs: number;

  @Column({ default: false })
  disabled: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => WebhookSubscription, (sub) => sub.webhook, { cascade: true })
  subscriptions: WebhookSubscription[];

  @OneToMany(() => WebhookDelivery, (del) => del.webhook)
  deliveries: WebhookDelivery[];
}

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

@Entity('webhook_subscriptions')
@Index(['webhookId'])
@Index(['eventType'])
@Index(['webhookId', 'eventType'], { unique: true })
export class WebhookSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  webhookId: string;

  @ManyToOne(() => Webhook, (webhook) => webhook.subscriptions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'webhookId' })
  webhook: Webhook;

  @Column()
  eventType: string;

  @Column({ type: 'json', nullable: true })
  filters: Record<string, any> | null;

  @CreateDateColumn()
  createdAt: Date;
}

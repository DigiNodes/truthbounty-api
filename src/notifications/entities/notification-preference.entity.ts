import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../entities/user.entity';
import { DeliveryChannel } from '../interfaces/notification.types';

export interface QuietHours {
  enabled: boolean;
  startTime?: string; // HH:mm format
  endTime?: string; // HH:mm format
  timezone?: string; // e.g., 'America/New_York'
}

export interface DigestPreferences {
  enabled: boolean;
  frequency?: 'DAILY' | 'WEEKLY'; // default: DAILY
  deliveryTime?: string; // HH:mm format, default: '09:00'
}

export interface ChannelPreferences {
  [DeliveryChannel.IN_APP]?: boolean;
  [DeliveryChannel.EMAIL]?: boolean;
  [DeliveryChannel.PUSH]?: boolean;
  [DeliveryChannel.WEBHOOK]?: boolean;
  [DeliveryChannel.WEBSOCKET]?: boolean;
}

export interface CategorySubscriptions {
  [key: string]: boolean; // EventType -> enabled
}

@Entity('notification_preferences')
@Index(['userId'], { unique: true })
export class NotificationPreference {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true })
  @Index()
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'userId' })
  user?: User;

  /**
   * Per-channel enablement
   * Default: IN_APP and EMAIL enabled
   */
  @Column({ type: 'jsonb', default: { IN_APP: true, EMAIL: true, PUSH: false, WEBHOOK: false, WEBSOCKET: true } })
  channels: ChannelPreferences;

  /**
   * Per-event-type subscriptions
   * Default: all categories enabled
   * Empty = use default (all enabled)
   */
  @Column({ type: 'jsonb', nullable: true, default: {} })
  categorySubscriptions: CategorySubscriptions;

  /**
   * Quiet hours configuration (when NOT to send notifications)
   * Timezone-aware to prevent late-night spam
   */
  @Column({ type: 'jsonb', nullable: true })
  quietHours?: QuietHours;

  /**
   * Digest mode configuration (batch notifications)
   * When enabled, notifications are accumulated and sent in batches
   */
  @Column({ type: 'jsonb', nullable: true })
  digestPreferences?: DigestPreferences;

  /**
   * Language preference for notification content
   */
  @Column({ type: 'varchar', default: 'en' })
  language: string;

  /**
   * Maximum notifications per day (rate limiting)
   * Null = unlimited
   */
  @Column({ type: 'int', nullable: true })
  maxNotificationsPerDay?: number;

  /**
   * Maximum emails per day
   * Null = unlimited
   */
  @Column({ type: 'int', nullable: true })
  maxEmailsPerDay?: number;

  /**
   * Email address for email notifications
   * If null, uses user's verified email from User entity
   */
  @Column({ type: 'varchar', nullable: true })
  emailAddress?: string;

  /**
   * Webhook configuration for custom integrations
   */
  @Column({ type: 'jsonb', nullable: true })
  webhookConfig?: {
    url: string;
    secret?: string;
    events?: string[]; // EventTypes to webhook
    retryAttempts?: number;
    timeout?: number; // ms
  };

  /**
   * Push notification configuration
   */
  @Column({ type: 'jsonb', nullable: true })
  pushConfig?: {
    enabled: boolean;
    deviceTokens?: string[]; // FCM or other provider tokens
  };

  /**
   * Unsubscribe token for email unsubscribe links
   */
  @Column({ type: 'varchar', unique: true, nullable: true })
  unsubscribeToken?: string;

  /**
   * Track when user last modified preferences
   */
  @Column({ type: 'timestamp', nullable: true })
  lastModifiedAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
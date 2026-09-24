import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { NotificationCategory } from '../enums/notification-category.enum';
import { NotificationStatus } from '../enums/notification-status.enum';

export enum NotificationType {
  NEW_CLAIM = 'new_claim',
  VERIFICATION_ASSIGNMENT = 'verification_assignment',
  DISPUTE_CREATED = 'dispute_created',
  DISPUTE_RESOLVED = 'dispute_resolved',
  REPUTATION_UPDATE = 'reputation_update',
  STAKING_CHANGE = 'staking_change',
  GOVERNANCE_PROPOSAL = 'governance_proposal',
  PROPOSAL_VOTE = 'proposal_vote',
  REWARD_DISTRIBUTED = 'reward_distributed',
  MODERATION_ACTION = 'moderation_action',
  SECURITY_ALERT = 'security_alert',
}

export enum NotificationChannel {
  IN_APP = 'in_app',
  WEBSOCKET = 'websocket',
  PUSH = 'push',
  EMAIL = 'email',
  WEBHOOK = 'webhook',
}

export enum DeliveryStatus {
  PENDING = 'pending',
  DELIVERED = 'delivered',
  FAILED = 'failed',
  RETRYING = 'retrying',
  DEAD_LETTER = 'dead_letter',
}

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  @Index()
  userId: string;

  @Column({ type: 'varchar', nullable: true })
  @Index()
  recipientId?: string;

  @Column({
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  type?: NotificationType;

  @Column({ type: 'varchar', nullable: true })
  category?: NotificationCategory;

  @Column({ type: 'varchar', nullable: true })
  channel?: NotificationChannel;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text', nullable: true })
  content?: string;

  @Column({ type: 'text', nullable: true })
  message?: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @Column({ type: 'varchar', default: NotificationStatus.QUEUED })
  status: NotificationStatus;

  @Column({ type: 'int', default: 0 })
  retryCount: number;

  @Column({ type: 'varchar', nullable: true })
  errorMessage?: string;

  @Column({ type: 'boolean', default: false })
  read: boolean;

  @Column({ type: 'timestamp', nullable: true })
  readAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

@Entity('notification_delivery_history')
export class NotificationDeliveryHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  notificationId: string;

  @Column()
  @Index()
  recipientId: string;

  @Column({
    type: 'varchar',
    length: 30,
  })
  channel: NotificationChannel;

  @Column({
    type: 'varchar',
    length: 30,
  })
  status: DeliveryStatus;

  @Column({ type: 'timestamp', nullable: true })
  deliveredAt?: Date;

  @Column({ type: 'int', default: 0 })
  retryAttempts: number;

  @Column({ type: 'text', nullable: true })
  failureReason?: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

@Entity('user_notification_preferences')
@Index(['userId'], { unique: true })
export class UserNotificationPreferences {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column({ type: 'jsonb', nullable: true })
  enabledChannels?: Record<NotificationChannel, boolean>;

  @Column({ type: 'jsonb', nullable: true })
  enabledCategories?: Record<NotificationType, boolean>;

  @Column({ type: 'boolean', default: true })
  emailEnabled: boolean;

  @Column({ type: 'varchar', nullable: true })
  emailAddress?: string;

  @Column({ type: 'boolean', default: true })
  governanceAlerts: boolean;

  @Column({ type: 'boolean', default: true })
  stakingAlerts: boolean;

  @Column({ type: 'boolean', default: true })
  rewardNotifications: boolean;

  @Column({ type: 'boolean', default: true })
  securityAlerts: boolean;

  @Column({ type: 'jsonb', nullable: true })
  webhookConfig?: {
    url: string;
    secret: string;
    enabled: boolean;
  };

  @Column({ type: 'jsonb', nullable: true })
  pushSubscription?: {
    endpoint: string;
    keys: Record<string, string>;
  };

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
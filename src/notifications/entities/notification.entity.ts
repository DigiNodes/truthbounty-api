import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

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

  @Column()
  @Index()
  recipientId: string;

  @Column({
    type: 'varchar',
    length: 50,
  })
  type: NotificationType;

  @Column('text')
  title: string;

  @Column('text')
  message: string;

  @Column('jsonb', { nullable: true })
  metadata: Record<string, any>;

  @Column({ default: false })
  read: boolean;

  @Column({ nullable: true })
  readAt: Date;

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

  @Column({ nullable: true })
  deliveredAt: Date;

  @Column({ default: 0 })
  retryAttempts: number;

  @Column('text', { nullable: true })
  failureReason: string;

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

  @Column('jsonb')
  enabledChannels: Record<NotificationChannel, boolean>;

  @Column('jsonb')
  enabledCategories: Record<NotificationType, boolean>;

  @Column({ default: true })
  emailEnabled: boolean;

  @Column({ nullable: true })
  emailAddress: string;

  @Column({ default: true })
  governanceAlerts: boolean;

  @Column({ default: true })
  stakingAlerts: boolean;

  @Column({ default: true })
  rewardNotifications: boolean;

  @Column({ default: true })
  securityAlerts: boolean;

  @Column('jsonb', { nullable: true })
  webhookConfig: {
    url: string;
    secret: string;
    enabled: boolean;
  };

  @Column('jsonb', { nullable: true })
  pushSubscription: {
    endpoint: string;
    keys: Record<string, string>;
  };

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
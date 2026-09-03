export enum NotificationCategory {
  NEW_CLAIM = 'new_claim',
  VERIFICATION_ASSIGNMENT = 'verification_assignment',
  DISPUTE_CREATED = 'dispute_created',
  DISPUTE_RESOLVED = 'dispute_resolved',
  REPUTATION_UPDATE = 'reputation_update',
  STAKING_CHANGE = 'staking_change',
  GOVERNANCE_PROPOSAL = 'governance_proposal',
  PROPOSAL_VOTING = 'proposal_voting',
  REWARD_DISTRIBUTION = 'reward_distribution',
  MODERATION_ACTION = 'moderation_action',
  SECURITY_ALERT = 'security_alert',
  VOTING_DEADLINE = 'voting_deadline',
  SYSTEM_UPDATE = 'system_update',
}

export enum NotificationPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum DeliveryChannel {
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
  PERMANENT_FAILURE = 'permanent_failure',
  RETRYING = 'retrying',
}

export interface NotificationEvent {
  eventType: string;
  source: string;
  timestamp: Date;
  payload: Record<string, any>;
  recipientIds: string[];
}

export interface DeliveryResult {
  success: boolean;
  status: DeliveryStatus;
  error?: string;
  deliveredAt?: Date;
}

export interface UserPreferenceSettings {
  enabledChannels: DeliveryChannel[];
  categories: {
    [key in NotificationCategory]?: boolean;
  };
  emailPreferences: {
    digestEnabled: boolean;
    digestFrequency: 'daily' | 'weekly' | 'never';
    emailAddress?: string;
  };
  governanceAlerts: boolean;
  stakingAlerts: boolean;
  rewardNotifications: boolean;
  securityAlerts: boolean;
}

export interface WebhookConfig {
  id: string;
  url: string;
  secret: string;
  events: string[];
  userId: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PushSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userId: string;
  userAgent?: string;
  createdAt: Date;
}
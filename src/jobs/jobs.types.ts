export enum QueueName {
  DEFAULT = 'jobs-queue',
  NOTIFICATIONS = 'notifications-queue',
  BLOCKCHAIN = 'blockchain-queue',
  ANALYTICS = 'analytics-queue',
}

export enum JobName {
  CLEANUP_SYBIL_HISTORY = 'cleanup-sybil-history',
  // V2 Architecture: COMPUTE_SCORES and COMPUTE_REPUTATION jobs removed
  // These jobs previously contained backend-authoritative logic that
  // automatically finalized claims based on backend calculations.
  // In V2, all claim state transitions must come from on-chain events
  // projected by the V2 projectors, not from backend calculations.
  SEND_NOTIFICATION = 'send-notification',
  INDEX_BLOCKCHAIN_EVENTS = 'index-blockchain-events',
  AGGREGATE_ANALYTICS = 'aggregate-analytics',
}

export enum JobPriority {
  CRITICAL = 1,
  HIGH = 2,
  NORMAL = 3,
  LOW = 4,
  BACKGROUND = 5,
}

export interface RetryPolicy {
  attempts: number;
  backoff: {
    type: 'exponential' | 'fixed';
    delay: number;
  };
}

export interface QueueMetrics {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
}

export interface JobOptions {
  priority?: JobPriority;
  delay?: number;
  attempts?: number;
  backoffDelay?: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
};
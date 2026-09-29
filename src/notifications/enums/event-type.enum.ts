/**
 * Protocol event types that trigger notifications
 * These are standardized event identifiers across the TruthBounty ecosystem
 */
export enum EventType {
  // Claim events
  CLAIM_CREATED = 'CLAIM_CREATED',
  CLAIM_UPDATED = 'CLAIM_UPDATED',
  CLAIM_RESOLVED = 'CLAIM_RESOLVED',
  CLAIM_ARCHIVED = 'CLAIM_ARCHIVED',

  // Verification events
  VERIFICATION_ASSIGNED = 'VERIFICATION_ASSIGNED',
  VERIFICATION_COMPLETED = 'VERIFICATION_COMPLETED',
  VERIFICATION_CONTESTED = 'VERIFICATION_CONTESTED',

  // Dispute events
  DISPUTE_INITIATED = 'DISPUTE_INITIATED',
  DISPUTE_ESCALATED = 'DISPUTE_ESCALATED',
  DISPUTE_RESOLVED = 'DISPUTE_RESOLVED',

  // Governance events
  GOVERNANCE_PROPOSAL_CREATED = 'GOVERNANCE_PROPOSAL_CREATED',
  GOVERNANCE_VOTE_REMINDER = 'GOVERNANCE_VOTE_REMINDER',
  GOVERNANCE_VOTE_CAST = 'GOVERNANCE_VOTE_CAST',
  GOVERNANCE_VOTE_CLOSED = 'GOVERNANCE_VOTE_CLOSED',
  GOVERNANCE_PROPOSAL_EXECUTED = 'GOVERNANCE_PROPOSAL_EXECUTED',

  // Reward events
  REWARD_ELIGIBLE = 'REWARD_ELIGIBLE',
  REWARD_DISTRIBUTED = 'REWARD_DISTRIBUTED',
  REWARD_CLAIMED = 'REWARD_CLAIMED',

  // Reputation events
  REPUTATION_CHANGED = 'REPUTATION_CHANGED',
  REPUTATION_WARNING = 'REPUTATION_WARNING',
  REPUTATION_PENALTY = 'REPUTATION_PENALTY',

  // Staking events
  STAKE_ADDED = 'STAKE_ADDED',
  STAKE_REMOVED = 'STAKE_REMOVED',
  STAKE_SLASHED = 'STAKE_SLASHED',

  // Moderation events
  MODERATION_ACTION = 'MODERATION_ACTION',
  CONTENT_FLAGGED = 'CONTENT_FLAGGED',
  USER_RESTRICTED = 'USER_RESTRICTED',

  // Admin/System events
  SYSTEM_ALERT = 'SYSTEM_ALERT',
  SECURITY_INCIDENT = 'SECURITY_INCIDENT',
  MAINTENANCE_SCHEDULED = 'MAINTENANCE_SCHEDULED',
}

/**
 * Map event types to notification priorities
 * Used for routing and retry strategies
 */
export const EVENT_PRIORITY_MAP: Record<EventType, 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'> = {
  // Claim events
  [EventType.CLAIM_CREATED]: 'NORMAL',
  [EventType.CLAIM_UPDATED]: 'LOW',
  [EventType.CLAIM_RESOLVED]: 'NORMAL',
  [EventType.CLAIM_ARCHIVED]: 'LOW',

  // Verification events
  [EventType.VERIFICATION_ASSIGNED]: 'HIGH',
  [EventType.VERIFICATION_COMPLETED]: 'NORMAL',
  [EventType.VERIFICATION_CONTESTED]: 'HIGH',

  // Dispute events
  [EventType.DISPUTE_INITIATED]: 'NORMAL',
  [EventType.DISPUTE_ESCALATED]: 'HIGH',
  [EventType.DISPUTE_RESOLVED]: 'NORMAL',

  // Governance events
  [EventType.GOVERNANCE_PROPOSAL_CREATED]: 'NORMAL',
  [EventType.GOVERNANCE_VOTE_REMINDER]: 'NORMAL',
  [EventType.GOVERNANCE_VOTE_CAST]: 'LOW',
  [EventType.GOVERNANCE_VOTE_CLOSED]: 'NORMAL',
  [EventType.GOVERNANCE_PROPOSAL_EXECUTED]: 'HIGH',

  // Reward events
  [EventType.REWARD_ELIGIBLE]: 'NORMAL',
  [EventType.REWARD_DISTRIBUTED]: 'NORMAL',
  [EventType.REWARD_CLAIMED]: 'LOW',

  // Reputation events
  [EventType.REPUTATION_CHANGED]: 'LOW',
  [EventType.REPUTATION_WARNING]: 'HIGH',
  [EventType.REPUTATION_PENALTY]: 'HIGH',

  // Staking events
  [EventType.STAKE_ADDED]: 'LOW',
  [EventType.STAKE_REMOVED]: 'LOW',
  [EventType.STAKE_SLASHED]: 'URGENT',

  // Moderation events
  [EventType.MODERATION_ACTION]: 'HIGH',
  [EventType.CONTENT_FLAGGED]: 'NORMAL',
  [EventType.USER_RESTRICTED]: 'URGENT',

  // Admin/System events
  [EventType.SYSTEM_ALERT]: 'HIGH',
  [EventType.SECURITY_INCIDENT]: 'URGENT',
  [EventType.MAINTENANCE_SCHEDULED]: 'NORMAL',
};

/**
 * Default retry configuration per event priority
 */
export const PRIORITY_RETRY_CONFIG = {
  LOW: { maxRetries: 3, initialDelayMs: 2000, backoffMultiplier: 2 },
  NORMAL: { maxRetries: 5, initialDelayMs: 2000, backoffMultiplier: 2 },
  HIGH: { maxRetries: 7, initialDelayMs: 1000, backoffMultiplier: 1.5 },
  URGENT: { maxRetries: 10, initialDelayMs: 500, backoffMultiplier: 1.5 },
};

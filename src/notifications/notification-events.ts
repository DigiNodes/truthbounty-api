import { NotificationCategory, NotificationChannel } from './notification-templates';

/**
 * Canonical event types for the notification subsystem.
 *
 * The canonical moderation event is `MODERATION_ACTION`. The legacy
 * `MODERATOR_ACTION` value is retained only as an explicitly versioned
 * alias for migration and is normalized at the boundary.
 */
export enum EventType {
  CLAIM_CREATED = 'CLAIM_CREATED',
  CLAIM_UPDATED = 'CLAIM_UPDATED',
  CLAIM_RESOLVED = 'CLAIM_RESOLVED',
  VERIFICATION_REQUESTED = 'VERIFICATION_REQUESTED',
  VERIFICATION_COMPLETED = 'VERIFICATION_COMPLETED',
  VERIFICATION_FAILED = 'VERIFICATION_FAILED',
  DISPUTE_OPENED = 'DISPUTE_OPENED',
  DISPUTE_RESOLVED = 'DISPUTE_RESOLVED',
  GOVERNANCE_PROPOSAL_CREATED = 'GOVERNANCE_PROPOSAL_CREATED',
  GOVERNANCE_VOTE_CAST = 'GOVERNANCE_VOTE_CAST',
  GOVERNANCE_PROPOSAL_RESOLVED = 'GOVERNANCE_PROPOSAL_RESOLVED',
  REWARD_ISSUED = 'REWARD_ISSUED',
  REWARD_CLAIMED = 'REWARD_CLAIMED',
  MODERATION_ACTION = 'MODERATION_ACTION ',
  SUPPORT_TICKET_CREATED = 'SUPPORT_TICKET_CREATED',
  SUPPORT_TICKET_REPLIED = 'SUPPORT_TICKET_REPLIED',
}

/**
 * Legacy event type values that may still arrive from persisted queues
 * or external producers. These are normalized to the canonical model at the
 * boundary and never rendered directly.
 */
export const LEGACY_EVENT_TYPE_ALIASES: Readonly<Record<string, EventType>> =
  Object.freeze({
    MODERATOR_ACTION: EventType.MODERATION_ACTION,
  });

export interface NotificationEventPayload {
  readonly [variable: string]: unknown;
}

export interface NotificationEvent {
  readonly id: string;
  readonly type: EventType;
  readonly recipientId: string;
  readonly payload: NotificationEventPayload;
  readonly channels?: readonly NotificationChannel[];
  readonly category?: NotificationCategory;
  readonly createdAt?: Date;
}

export class UnknownEventTypeError extends Error {
  constructor(public readonly rawType: string) {
    super(`Unknown notification event type: ${rawType}`);
    this.name = 'UnknownEventTypeError';
  }
}

export function isEventType(value: unknown): value is EventType {
  if (typeof value !== 'string') return false;
  return (Object.values(EventType) as string[]).includes(value);
}

/**
 * Normalize an incoming event type string to the canonical `EventType`
 * enum. Legacy aliases are resolved explicitly; anything else fails closed.
 */
export function normalizeEventType(rawType: unknown): EventType {
  if (typeof rawType !== 'string') {
    throw new UnknownEventTypeError(String(rawType));
  }
  if (isEventType(rawType)) {
    return rawType;
  }
  const alias = LEGACY_EVENT_TYPE_ALIASES[rawType];
  if (alias) {
    return alias;
  }
  throw new UnknownEventTypeError(rawType);
}

import { EventType } from '../enums/event-type.enum';
import { DeliveryChannel } from '../interfaces/notification.types';

/**
 * Channel-agnostic rendered content.
 *
 * This is the only shape a delivery worker may read when composing a provider
 * request. It intentionally excludes destinations, credentials, wallet
 * signatures, and any other protected material.
 */
export interface RenderedNotificationContent {
  title?: string;
  subject?: string;
  body: string;
  html?: string;
  markdown?: string;
  actionUrl?: string;
}

/**
 * The single canonical payload accepted by every notification delivery worker.
 *
 * PREWAVE-BE-027 requires that workers stop accepting a mix of the
 * `Notification` entity, `NotificationDelivery` entity, and ad-hoc objects:
 * all of them converge on this one type. Provider-specific routing data lives
 * under `metadata` (opaque, non-sensitive), never as top-level fields.
 */
export interface RenderedNotificationPayload {
  /** Notification aggregate id, used for idempotency and audit correlation. */
  notificationId?: string;
  userId: string;
  channel: DeliveryChannel;
  eventType: EventType;
  rendered: RenderedNotificationContent;
  metadata: Record<string, unknown>;
  /** Deterministic key that makes at-least-once delivery idempotent. */
  idempotencyKey?: string;
}

/**
 * Minimal structural view of the `Notification` entity that a worker may hold.
 * Declared structurally so this module never imports the entity (and therefore
 * never drags TypeORM into unit tests).
 */
export interface NotificationLike {
  id: string;
  userId?: string | null;
  recipientId?: string | null;
  title?: string | null;
  content?: string | null;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
  type?: string | null;
}

/** Maps the legacy entity notification type onto a canonical event type. */
const NOTIFICATION_TYPE_TO_EVENT: Readonly<Partial<Record<string, EventType>>> =
  {
    new_claim: EventType.CLAIM_CREATED,
    claim_submitted: EventType.CLAIM_CREATED,
    verification_assignment: EventType.VERIFICATION_ASSIGNED,
    dispute_created: EventType.DISPUTE_INITIATED,
    dispute_resolved: EventType.DISPUTE_RESOLVED,
    reputation_update: EventType.REPUTATION_CHANGED,
    staking_change: EventType.STAKE_ADDED,
    governance_proposal: EventType.GOVERNANCE_PROPOSAL_CREATED,
    proposal_vote: EventType.GOVERNANCE_VOTE_CAST,
    reward_distributed: EventType.REWARD_DISTRIBUTED,
    rewards_distributed: EventType.REWARD_DISTRIBUTED,
    moderation_action: EventType.MODERATION_ACTION,
    security_alert: EventType.SECURITY_INCIDENT,
    system_update: EventType.SYSTEM_ALERT,
  };

/**
 * Resolve a canonical `EventType` from an untrusted notification type string.
 * Unknown values fall back to `SYSTEM_ALERT` so a malformed row can never
 * crash the worker.
 */
export function resolveEventTypeFromNotificationType(
  type?: string | null,
): EventType {
  if (!type) {
    return EventType.SYSTEM_ALERT;
  }

  const normalized = type.trim().toLowerCase();
  const mapped = NOTIFICATION_TYPE_TO_EVENT[normalized];
  if (mapped) {
    return mapped;
  }

  const upper = type.trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(EventType, upper)) {
    return (EventType as unknown as Record<string, EventType>)[upper];
  }

  return EventType.SYSTEM_ALERT;
}

/**
 * Build the canonical payload from a legacy `Notification` entity.
 *
 * This is the single conversion point used by workers that are handed an
 * entity (for example the BullMQ processor) rather than an already-rendered
 * payload. It copies only display content and opaque metadata.
 */
export function toRenderedNotificationPayload(
  notification: NotificationLike,
  channel: DeliveryChannel,
  eventType?: EventType,
  idempotencyKey?: string,
): RenderedNotificationPayload {
  const body =
    notification.message ?? notification.content ?? notification.title ?? '';

  return {
    notificationId: notification.id,
    userId: notification.recipientId ?? notification.userId ?? '',
    channel,
    eventType:
      eventType ?? resolveEventTypeFromNotificationType(notification.type),
    rendered: {
      title: notification.title ?? undefined,
      subject: notification.title ?? undefined,
      body,
      html: notification.content ?? undefined,
    },
    metadata: {
      ...(notification.metadata ?? {}),
      notificationId: notification.id,
    },
    idempotencyKey,
  };
}

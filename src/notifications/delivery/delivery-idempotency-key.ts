import { createHash } from 'crypto';
import { DeliveryChannel } from '../interfaces/notification.types';

/**
 * Canonical identity of one notification-recipient-channel delivery.
 *
 * Every outbox producer, worker, orchestrator and channel provider must derive
 * the delivery idempotency key from this shape. Redis, BullMQ job ids and the
 * provider `X-Idempotency-Key` header are all downstream projections of the
 * same value.
 */
export interface DeliveryIdentity {
  eventType: string;
  recipientId: string;
  channel: DeliveryChannel;
  aggregateId?: string;
}

export const DELIVERY_CLAIM_KEY_PREFIX = 'delivery:claim:';
export const DELIVERED_CACHE_KEY_PREFIX = 'delivery:delivered:';

export function buildDeliveryIdempotencyKey(
  identity: DeliveryIdentity,
): string {
  const aggregateId = identity.aggregateId ?? '';
  const raw = [
    identity.eventType,
    identity.recipientId,
    identity.channel,
    aggregateId,
  ].join(':');

  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Event-level outbox key. It is derived from the canonical per-delivery keys
 * so an outbox row and the jobs/claims it produces agree on identity. The
 * recipient list is sorted and de-duplicated, making publication order
 * irrelevant.
 */
export function buildOutboxIdempotencyKey(
  eventType: string,
  aggregateId: string,
  recipientIds: string[],
  channel: DeliveryChannel = DeliveryChannel.IN_APP,
): string {
  const deliveryKeys = [...new Set(recipientIds)].sort().map((recipientId) =>
    buildDeliveryIdempotencyKey({
      eventType,
      recipientId,
      channel,
      aggregateId,
    }),
  );

  return createHash('sha256')
    .update(`${eventType}:${aggregateId}:${channel}:${deliveryKeys.join(',')}`)
    .digest('hex');
}

export function deliveryClaimCacheKey(idempotencyKey: string): string {
  return `${DELIVERY_CLAIM_KEY_PREFIX}${idempotencyKey}`;
}

export function deliveredCacheKey(idempotencyKey: string): string {
  return `${DELIVERED_CACHE_KEY_PREFIX}${idempotencyKey}`;
}

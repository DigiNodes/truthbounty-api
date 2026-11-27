import {
  buildDeliveryIdempotencyKey,
  buildOutboxIdempotencyKey,
} from './delivery-idempotency-key';
import { DeliveryChannel } from '../interfaces/notification.types';

describe('delivery idempotency key composition', () => {
  const identity = {
    eventType: 'claim.created',
    recipientId: 'user-1',
    channel: DeliveryChannel.EMAIL,
    aggregateId: 'claim-1',
  };

  it('is deterministic and includes recipient and channel', () => {
    const key = buildDeliveryIdempotencyKey(identity);

    expect(key).toBe(buildDeliveryIdempotencyKey(identity));
    expect(key).toHaveLength(64);
    expect(key).not.toBe(
      buildDeliveryIdempotencyKey({
        ...identity,
        channel: DeliveryChannel.WEBHOOK,
      }),
    );
    expect(key).not.toBe(
      buildDeliveryIdempotencyKey({ ...identity, recipientId: 'user-2' }),
    );
  });

  it('derives outbox keys from canonical delivery keys and ignores recipient order', () => {
    const first = buildOutboxIdempotencyKey(
      'claim.created',
      'claim-1',
      ['user-1', 'user-2'],
      DeliveryChannel.EMAIL,
    );
    const second = buildOutboxIdempotencyKey(
      'claim.created',
      'claim-1',
      ['user-2', 'user-1'],
      DeliveryChannel.EMAIL,
    );

    expect(first).toBe(second);
    expect(first).toHaveLength(64);
  });
});

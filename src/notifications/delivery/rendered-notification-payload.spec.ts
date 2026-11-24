import {
  resolveEventTypeFromNotificationType,
  toRenderedNotificationPayload,
} from './rendered-notification-payload';
import { DeliveryChannel } from '../interfaces/notification.types';
import { EventType } from '../enums/event-type.enum';

describe('toRenderedNotificationPayload', () => {
  it('maps a notification entity onto the canonical payload', () => {
    const payload = toRenderedNotificationPayload(
      {
        id: 'n1',
        userId: 'user-owner',
        recipientId: 'user-recipient',
        title: 'Claim updated',
        message: 'Your claim is ready.',
        metadata: { foo: 'bar' },
        type: 'claim_submitted',
      },
      DeliveryChannel.EMAIL,
    );

    expect(payload).toMatchObject({
      notificationId: 'n1',
      userId: 'user-recipient',
      channel: DeliveryChannel.EMAIL,
      eventType: EventType.CLAIM_CREATED,
    });
    expect(payload.rendered.body).toBe('Your claim is ready.');
    expect(payload.metadata).toMatchObject({
      foo: 'bar',
      notificationId: 'n1',
    });
  });

  it('prefers recipientId but falls back to userId', () => {
    const payload = toRenderedNotificationPayload(
      { id: 'n2', userId: 'owner', title: 'Hello' },
      DeliveryChannel.IN_APP,
    );
    expect(payload.userId).toBe('owner');
    expect(payload.rendered.body).toBe('Hello');
  });

  it('does not leak the provider destination into rendered content', () => {
    const payload = toRenderedNotificationPayload(
      {
        id: 'n3',
        userId: 'u3',
        title: 'Secret',
        metadata: { destination: 'secret@example.com' },
      },
      DeliveryChannel.EMAIL,
    );

    expect(JSON.stringify(payload.rendered)).not.toContain(
      'secret@example.com',
    );
  });

  describe('resolveEventTypeFromNotificationType', () => {
    it('maps legacy notification types', () => {
      expect(resolveEventTypeFromNotificationType('dispute_resolved')).toBe(
        EventType.DISPUTE_RESOLVED,
      );
      expect(resolveEventTypeFromNotificationType('security_alert')).toBe(
        EventType.SECURITY_INCIDENT,
      );
    });

    it('accepts canonical event-type strings', () => {
      expect(resolveEventTypeFromNotificationType('CLAIM_RESOLVED')).toBe(
        EventType.CLAIM_RESOLVED,
      );
    });

    it('falls back safely for null and unknown values', () => {
      expect(resolveEventTypeFromNotificationType(null)).toBe(
        EventType.SYSTEM_ALERT,
      );
      expect(resolveEventTypeFromNotificationType('mystery')).toBe(
        EventType.SYSTEM_ALERT,
      );
    });
  });
});

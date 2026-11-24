import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { InAppDeliveryService } from './in-app-delivery.service';
import { EmailDeliveryService } from './email-delivery.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { PushDeliveryService } from './push-delivery.service';
import { SmsDeliveryService } from './sms-delivery.service';
import { DeliveryChannel } from '../../interfaces/notification.types';
import { EventType } from '../../enums/event-type.enum';
import type { RenderedNotificationPayload } from '../../delivery/rendered-notification-payload';

function createPayload(
  overrides: Partial<RenderedNotificationPayload> = {},
): RenderedNotificationPayload {
  return {
    notificationId: 'notif-1',
    userId: 'user-1',
    channel: DeliveryChannel.IN_APP,
    eventType: EventType.SYSTEM_ALERT,
    rendered: { title: 'Test', subject: 'Test', body: 'Test body' },
    metadata: {},
    ...overrides,
  };
}

describe('Delivery Channels', () => {
  describe('InAppDeliveryService', () => {
    let service: InAppDeliveryService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [InAppDeliveryService],
      }).compile();
      service = module.get<InAppDeliveryService>(InAppDeliveryService);
    });

    it('should deliver in-app notifications', async () => {
      const result = await service.deliver(createPayload());
      expect(result.success).toBe(true);
      expect(result.deliveredAt).toBeDefined();
    });
  });

  describe('EmailDeliveryService', () => {
    let service: EmailDeliveryService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string) => {
                if (key === 'SMTP_HOST') return 'localhost';
                if (key === 'SMTP_PORT') return 587;
                if (key === 'SMTP_USER') return '';
                if (key === 'SMTP_PASS') return '';
                if (key === 'SMTP_FROM') return 'noreply@test.com';
                return undefined;
              }),
            },
          },
          EmailDeliveryService,
        ],
      }).compile();
      service = module.get<EmailDeliveryService>(EmailDeliveryService);
    });

    it('should fail when no destination configured', async () => {
      const result = await service.deliver(createPayload());
      expect(result.success).toBe(false);
      expect(result.failureReason).toContain('No email destination');
    });

    it('should record email when SMTP not configured', async () => {
      const result = await service.deliver(
        createPayload({ metadata: { destination: 'test@example.com' } }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe('WebhookDeliveryService', () => {
    let service: WebhookDeliveryService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [WebhookDeliveryService],
      }).compile();
      service = module.get<WebhookDeliveryService>(WebhookDeliveryService);
    });

    it('should fail when no webhook URL configured', async () => {
      const result = await service.deliver(
        createPayload({ channel: DeliveryChannel.WEBHOOK }),
      );
      expect(result.success).toBe(false);
      expect(result.failureReason).toContain('No webhook URL');
    });

    it('should handle webhook delivery failure gracefully', async () => {
      const result = await service.deliver(
        createPayload({
          channel: DeliveryChannel.WEBHOOK,
          metadata: {
            destination:
              'http://invalid-url-that-will-fail.example.com/webhook',
          },
        }),
      );
      expect(result.success).toBe(false);
    });
  });

  describe('PushDeliveryService', () => {
    let service: PushDeliveryService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [PushDeliveryService],
      }).compile();
      service = module.get<PushDeliveryService>(PushDeliveryService);
    });

    it('should fail when no push token configured', async () => {
      const result = await service.deliver(
        createPayload({ channel: DeliveryChannel.PUSH }),
      );
      expect(result.success).toBe(false);
      expect(result.failureReason).toContain('No push token');
    });

    it('should succeed with push token (logging mode)', async () => {
      const result = await service.deliver(
        createPayload({
          channel: DeliveryChannel.PUSH,
          metadata: { destination: 'fcm-token-abc123' },
        }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe('SmsDeliveryService', () => {
    let service: SmsDeliveryService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [SmsDeliveryService],
      }).compile();
      service = module.get<SmsDeliveryService>(SmsDeliveryService);
    });

    it('should fail when no phone number configured', async () => {
      const result = await service.deliver(
        createPayload({ channel: DeliveryChannel.SMS }),
      );
      expect(result.success).toBe(false);
      expect(result.failureReason).toContain('No phone number');
    });

    it('should succeed with phone number (logging mode)', async () => {
      const result = await service.deliver(
        createPayload({
          channel: DeliveryChannel.SMS,
          metadata: { destination: '+1234567890' },
        }),
      );
      expect(result.success).toBe(true);
    });
  });
});

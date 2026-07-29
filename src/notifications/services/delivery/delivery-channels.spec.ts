import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { InAppDeliveryService } from './in-app-delivery.service';
import { EmailDeliveryService } from './email-delivery.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { PushDeliveryService } from './push-delivery.service';
import { SmsDeliveryService } from './sms-delivery.service';
import { NotificationDelivery } from '../../entities/notification-delivery.entity';
import { DeliveryChannel, DeliveryStatus } from '../../enums/notification-type.enum';

function createMockDelivery(overrides: Partial<NotificationDelivery> = {}): NotificationDelivery {
  return {
    id: 'del-1',
    notificationId: 'notif-1',
    channel: DeliveryChannel.IN_APP,
    status: DeliveryStatus.PENDING,
    retryCount: 0,
    maxRetries: 5,
    destination: null,
    failureReason: null,
    responseData: null,
    queuedAt: null,
    sentAt: null,
    deliveredAt: null,
    lastRetryAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    notification: null,
    ...overrides,
  } as NotificationDelivery;
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
      const delivery = createMockDelivery();
      const result = await service.deliver(delivery);
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
      const delivery = createMockDelivery({ destination: null });
      const result = await service.deliver(delivery);
      expect(result.success).toBe(false);
      expect(result.failureReason).toContain('No email destination');
    });

    it('should log email when SMTP not configured', async () => {
      const delivery = createMockDelivery({
        destination: 'test@example.com',
        responseData: { subject: 'Test', body: 'Test body' },
      });
      const result = await service.deliver(delivery);
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
      const delivery = createMockDelivery({ destination: null, channel: DeliveryChannel.WEBHOOK });
      const result = await service.deliver(delivery);
      expect(result.success).toBe(false);
      expect(result.failureReason).toContain('No webhook URL');
    });

    it('should handle webhook delivery failure gracefully', async () => {
      const delivery = createMockDelivery({
        destination: 'http://invalid-url-that-will-fail.example.com/webhook',
        channel: DeliveryChannel.WEBHOOK,
      });
      const result = await service.deliver(delivery);
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
      const delivery = createMockDelivery({ destination: null, channel: DeliveryChannel.PUSH });
      const result = await service.deliver(delivery);
      expect(result.success).toBe(false);
      expect(result.failureReason).toContain('No push token');
    });

    it('should succeed with push token (logging mode)', async () => {
      const delivery = createMockDelivery({
        destination: 'fcm-token-abc123',
        channel: DeliveryChannel.PUSH,
      });
      const result = await service.deliver(delivery);
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
      const delivery = createMockDelivery({ destination: null, channel: DeliveryChannel.SMS });
      const result = await service.deliver(delivery);
      expect(result.success).toBe(false);
      expect(result.failureReason).toContain('No phone number');
    });

    it('should succeed with phone number (logging mode)', async () => {
      const delivery = createMockDelivery({
        destination: '+1234567890',
        channel: DeliveryChannel.SMS,
      });
      const result = await service.deliver(delivery);
      expect(result.success).toBe(true);
    });
  });
});

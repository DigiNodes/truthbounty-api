import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { Webhook, WebhookEventType } from './entities/webhook.entity';
import { WebhookSubscription } from './entities/webhook-subscription.entity';
import { WebhookDelivery, DeliveryStatus } from './entities/webhook-delivery.entity';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { UpdateWebhookDto } from './dto/update-webhook.dto';

// ─── Mock prom-client ─────────────────────────────────────────────────────────
const mockCounter = { inc: jest.fn() };
const mockHistogram = { observe: jest.fn() };
const mockGauge = { set: jest.fn() };

jest.mock('prom-client', () => ({
  Counter: jest.fn(() => mockCounter),
  Histogram: jest.fn(() => mockHistogram),
  Gauge: jest.fn(() => mockGauge),
  register: {
    metrics: jest.fn().mockResolvedValue(''),
    clear: jest.fn(),
  },
}));

describe('WebhooksService', () => {
  let service: WebhooksService;
  let webhookRepo: Repository<Webhook>;
  let subscriptionRepo: Repository<WebhookSubscription>;
  let deliveryRepo: Repository<WebhookDelivery>;
  let webhookQueue: any;

  const mockWebhook = {
    id: 'wh-001',
    url: 'https://example.com/webhook',
    description: 'Test webhook',
    ownerId: '0x123',
    enabled: true,
    secret: 'test-secret-raw',
    previousSecret: null,
    previousSecretExpiresAt: null,
    secretExpiresAt: null,
    consecutiveFailures: 0,
    maxRetries: 3,
    retryIntervalMs: 30000,
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    subscriptions: [],
    deliveries: [],
  };

  const mockSubscription = {
    id: 'sub-001',
    webhookId: 'wh-001',
    eventType: WebhookEventType.CLAIM_CREATED,
    filters: null,
    createdAt: new Date(),
    webhook: mockWebhook,
  };

  beforeEach(async () => {
    const mockWebhookRepo = {
      create: jest.fn().mockReturnValue(mockWebhook),
      save: jest.fn().mockResolvedValue(mockWebhook),
      find: jest.fn().mockResolvedValue([mockWebhook]),
      findOne: jest.fn().mockResolvedValue(mockWebhook),
      findOneBy: jest.fn().mockResolvedValue(mockWebhook),
      remove: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn().mockResolvedValue(10),
    };

    const mockSubscriptionRepo = {
      create: jest.fn().mockReturnValue(mockSubscription),
      save: jest.fn().mockResolvedValue(mockSubscription),
      find: jest.fn().mockResolvedValue([mockSubscription]),
      findOne: jest.fn().mockResolvedValue(mockSubscription),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const mockDeliveryRepo = {
      create: jest.fn().mockReturnValue({ id: 'del-001' }),
      save: jest.fn().mockResolvedValue({ id: 'del-001' }),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue({
        id: 'del-001',
        webhookId: 'wh-001',
        eventType: 'claim.created',
        payload: {},
        status: DeliveryStatus.FAILED,
        retryCount: 0,
        maxRetries: 3,
        requestId: 'req-001',
        nonce: 'nonce',
        signature: 'sig',
        timestamp: new Date().toISOString(),
        responseStatus: null,
        responseBody: null,
        latency: null,
        failureReason: null,
        createdAt: new Date(),
        completedAt: null,
      }),
      count: jest.fn().mockResolvedValue(10),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      })),
    };

    const mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-001' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: getRepositoryToken(Webhook), useValue: mockWebhookRepo },
        { provide: getRepositoryToken(WebhookSubscription), useValue: mockSubscriptionRepo },
        { provide: getRepositoryToken(WebhookDelivery), useValue: mockDeliveryRepo },
        { provide: getQueueToken('webhook-delivery'), useValue: mockQueue },
      ],
    }).compile();

    service = module.get<WebhooksService>(WebhooksService);
    // Initialize metrics explicitly since onModuleInit is async and won't be auto-called in test
    await service.onModuleInit();

    webhookRepo = module.get(getRepositoryToken(Webhook));
    subscriptionRepo = module.get(getRepositoryToken(WebhookSubscription));
    deliveryRepo = module.get(getRepositoryToken(WebhookDelivery));
    webhookQueue = module.get(getQueueToken('webhook-delivery'));
  });

  // ─── Registration ──────────────────────────────────────────────────────

  describe('create', () => {
    it('should create a webhook with valid data', async () => {
      const dto: CreateWebhookDto = {
        url: 'https://example.com/webhook',
        description: 'Test webhook',
        ownerId: '0x123',
        enabled: true,
        events: [WebhookEventType.CLAIM_CREATED, WebhookEventType.VERIFICATION_COMPLETED],
        maxRetries: 3,
        retryIntervalMs: 30000,
      };

      // Mock findOne to return null (no duplicate)
      jest.spyOn(webhookRepo, 'findOne').mockResolvedValueOnce(null);

      const result = await service.create(dto);

      expect(result).toBeDefined();
      expect(webhookRepo.create).toHaveBeenCalled();
      expect(webhookRepo.save).toHaveBeenCalled();
      expect(subscriptionRepo.create).toHaveBeenCalledTimes(2);
    });

    it('should reject non-HTTPS URLs', async () => {
      const dto: CreateWebhookDto = {
        url: 'http://example.com/webhook',
        ownerId: '0x123',
        events: [WebhookEventType.CLAIM_CREATED],
      };

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });

    it('should reject duplicate active webhooks for same owner', async () => {
      const dto: CreateWebhookDto = {
        url: 'https://example.com/webhook',
        ownerId: '0x123',
        events: [WebhookEventType.CLAIM_CREATED],
      };

      // findOne returns existing webhook (duplicate)
      jest.spyOn(webhookRepo, 'findOne').mockResolvedValueOnce(mockWebhook);

      await expect(service.create(dto)).rejects.toThrow(ConflictException);
    });

    it('should reject invalid event types', async () => {
      const dto: CreateWebhookDto = {
        url: 'https://example.com/webhook',
        ownerId: '0x123',
        events: ['invalid.event' as WebhookEventType],
      };

      jest.spyOn(webhookRepo, 'findOne').mockResolvedValueOnce(null);

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });

    it('should reject empty events array', async () => {
      const dto: CreateWebhookDto = {
        url: 'https://example.com/webhook',
        ownerId: '0x123',
        events: [],
      };

      // Ensure no duplicate conflict is found first
      jest.spyOn(webhookRepo, 'findOne').mockResolvedValueOnce(null);

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('findAll', () => {
    it('should return all webhooks', async () => {
      const result = await service.findAll();
      expect(result).toHaveLength(1);
      expect(webhookRepo.find).toHaveBeenCalled();
    });

    it('should filter by ownerId', async () => {
      await service.findAll('0x123');
      expect(webhookRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ ownerId: '0x123' }),
        }),
      );
    });

    it('should filter by enabled status', async () => {
      await service.findAll(undefined, 'true');
      expect(webhookRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ enabled: true }),
        }),
      );
    });
  });

  describe('findOne', () => {
    it('should return a webhook by ID', async () => {
      const result = await service.findOne('wh-001');
      expect(result).toBeDefined();
      expect(result.id).toBe('wh-001');
    });

    it('should throw NotFoundException for missing webhook', async () => {
      jest.spyOn(webhookRepo, 'findOne').mockResolvedValueOnce(null);
      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update webhook URL', async () => {
      const dto: UpdateWebhookDto = { url: 'https://new-url.com/webhook' };
      const result = await service.update('wh-001', dto);
      expect(result).toBeDefined();
      expect(result.url).toBe(mockWebhook.url);
    });

    it('should reject non-HTTPS URL update', async () => {
      const dto: UpdateWebhookDto = { url: 'http://insecure-url.com' };
      await expect(service.update('wh-001', dto)).rejects.toThrow(BadRequestException);
    });

    it('should re-enable webhook when enabled is set to true', async () => {
      const dto: UpdateWebhookDto = { enabled: true };
      const result = await service.update('wh-001', dto);
      expect(result).toBeDefined();
    });

    it('should update event subscriptions', async () => {
      const dto: UpdateWebhookDto = {
        events: [WebhookEventType.DISPUTE_CREATED],
      };
      const result = await service.update('wh-001', dto);
      expect(result).toBeDefined();
      expect(subscriptionRepo.delete).toHaveBeenCalledWith({ webhookId: 'wh-001' });
    });
  });

  describe('remove', () => {
    it('should delete a webhook', async () => {
      await service.remove('wh-001');
      expect(webhookRepo.remove).toHaveBeenCalled();
    });

    it('should throw NotFoundException for missing webhook', async () => {
      jest.spyOn(webhookRepo, 'findOne').mockResolvedValueOnce(null);
      await expect(service.remove('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── Secret Management ──────────────────────────────────────────────────

  describe('rotateSecret', () => {
    it('should rotate the webhook secret', async () => {
      const result = await service.rotateSecret('wh-001');
      expect(result).toBeDefined();
      expect(result.secret).toBeDefined();
      expect(result.expiresAt).toBeDefined();
      expect(webhookRepo.save).toHaveBeenCalled();
    });
  });

  describe('revokeSecret', () => {
    it('should revoke the webhook secret', async () => {
      await service.revokeSecret('wh-001');
      expect(webhookRepo.save).toHaveBeenCalled();
    });
  });

  // ─── Event Dispatch ─────────────────────────────────────────────────────

  describe('dispatchEvent', () => {
    it('should dispatch event to subscribed webhooks', async () => {
      jest.spyOn(subscriptionRepo, 'find').mockResolvedValueOnce([mockSubscription]);

      const payload = {
        eventType: WebhookEventType.CLAIM_CREATED,
        eventId: 'evt-001',
        module: 'claims',
        timestamp: new Date().toISOString(),
        data: { claimId: 'claim-001' },
      };

      const count = await service.dispatchEvent(WebhookEventType.CLAIM_CREATED, payload);
      expect(count).toBe(1);
      expect(webhookQueue.add).toHaveBeenCalled();
    });

    it('should not dispatch when no subscribers', async () => {
      jest.spyOn(subscriptionRepo, 'find').mockResolvedValueOnce([]);

      const payload = {
        eventType: WebhookEventType.CLAIM_CREATED,
        eventId: 'evt-001',
        module: 'claims',
        timestamp: new Date().toISOString(),
        data: { claimId: 'claim-001' },
      };

      const count = await service.dispatchEvent(WebhookEventType.CLAIM_CREATED, payload);
      expect(count).toBe(0);
      expect(webhookQueue.add).not.toHaveBeenCalled();
    });
  });

  // ─── Delivery History ───────────────────────────────────────────────────

  describe('getDeliveries', () => {
    it('should return paginated deliveries', async () => {
      const result = await service.getDeliveries('wh-001');
      expect(result).toBeDefined();
      expect(result.deliveries).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });
  });

  describe('getDelivery', () => {
    it('should return a delivery by ID', async () => {
      const result = await service.getDelivery('del-001');
      expect(result).toBeDefined();
      expect(result.id).toBe('del-001');
    });

    it('should throw NotFoundException for missing delivery', async () => {
      jest.spyOn(deliveryRepo, 'findOne').mockResolvedValueOnce(null);
      await expect(service.getDelivery('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── Retry Logic ────────────────────────────────────────────────────────

  describe('retryDelivery', () => {
    it('should retry a failed delivery', async () => {
      await service.retryDelivery('del-001');
      expect(webhookQueue.add).toHaveBeenCalled();
    });
  });

  // ─── Status ─────────────────────────────────────────────────────────────

  describe('getWebhookStatus', () => {
    it('should return webhook status with metrics', async () => {
      const result = await service.getWebhookStatus('wh-001');
      expect(result).toBeDefined();
      expect(result.webhook).toBeDefined();
      expect(result.totalDeliveries).toBe(10);
      expect(result.successfulDeliveries).toBe(10);
      expect(result.failedDeliveries).toBe(10);
      expect(result.pendingDeliveries).toBe(10);
    });
  });

  // ─── Signature Verification ────────────────────────────────────────────

  describe('verifySignature', () => {
    it('should verify a valid signature', () => {
      const secret = 'test-secret';
      const payload = { data: 'test' };
      const timestamp = new Date().toISOString();
      const nonce = 'test-nonce';

      // Generate a signature using the same method
      const crypto = require('crypto');
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(`${timestamp}.${nonce}.${JSON.stringify(payload)}`);
      const validSignature = hmac.digest('hex');

      const result = service.verifySignature(payload, validSignature, secret, timestamp, nonce);
      expect(result).toBe(true);
    });

    it('should reject an invalid signature', () => {
      // Must be a 64-char hex string (same length as valid HMAC-SHA256)
      const invalidSig = 'a'.repeat(64);
      const result = service.verifySignature(
        { data: 'test' },
        invalidSig,
        'secret',
        new Date().toISOString(),
        'nonce',
      );
      expect(result).toBe(false);
    });
  });
});

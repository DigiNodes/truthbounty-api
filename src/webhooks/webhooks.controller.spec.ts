import { Test, TestingModule } from '@nestjs/testing';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { UpdateWebhookDto } from './dto/update-webhook.dto';
import { WebhookEventType } from './entities/webhook.entity';
import { DeliveryStatus } from './entities/webhook-delivery.entity';

describe('WebhooksController', () => {
  let controller: WebhooksController;
  let service: WebhooksService;

  const mockWebhook = {
    id: 'wh-001',
    url: 'https://example.com/webhook',
    description: 'Test webhook',
    ownerId: '0x123',
    enabled: true,
    secret: 'hashed',
    consecutiveFailures: 0,
    maxRetries: 3,
    retryIntervalMs: 30000,
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    subscriptions: [],
  };

  const mockService = {
    create: jest.fn().mockResolvedValue(mockWebhook),
    findAll: jest.fn().mockResolvedValue([mockWebhook]),
    findOne: jest.fn().mockResolvedValue(mockWebhook),
    update: jest.fn().mockResolvedValue(mockWebhook),
    remove: jest.fn().mockResolvedValue(undefined),
    getDeliveries: jest.fn().mockResolvedValue({ deliveries: [], total: 0, page: 1, limit: 20 }),
    getDelivery: jest.fn().mockResolvedValue({
      id: 'del-001',
      webhookId: 'wh-001',
      eventType: 'claim.created',
      status: DeliveryStatus.DELIVERED,
    }),
    retryDelivery: jest.fn().mockResolvedValue(undefined),
    rotateSecret: jest.fn().mockResolvedValue({ secret: 'new-secret', expiresAt: new Date() }),
    revokeSecret: jest.fn().mockResolvedValue(undefined),
    getWebhookStatus: jest.fn().mockResolvedValue({
      webhook: mockWebhook,
      totalDeliveries: 10,
      successfulDeliveries: 8,
      failedDeliveries: 2,
      pendingDeliveries: 0,
      lastDelivery: null,
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [{ provide: WebhooksService, useValue: mockService }],
    }).compile();

    controller = module.get<WebhooksController>(WebhooksController);
    service = module.get<WebhooksService>(WebhooksService);
  });

  describe('create', () => {
    it('should create a webhook', async () => {
      const dto: CreateWebhookDto = {
        url: 'https://example.com/webhook',
        ownerId: '0x123',
        events: [WebhookEventType.CLAIM_CREATED],
      };
      const result = await controller.create(dto);
      expect(result).toEqual(mockWebhook);
      expect(service.create).toHaveBeenCalledWith(dto);
    });
  });

  describe('findAll', () => {
    it('should return all webhooks', async () => {
      const result = await controller.findAll({});
      expect(result).toEqual([mockWebhook]);
      expect(service.findAll).toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('should return a webhook by ID', async () => {
      const result = await controller.findOne('wh-001');
      expect(result).toEqual(mockWebhook);
      expect(service.findOne).toHaveBeenCalledWith('wh-001');
    });
  });

  describe('update', () => {
    it('should update a webhook', async () => {
      const dto: UpdateWebhookDto = { enabled: false };
      const result = await controller.update('wh-001', dto);
      expect(result).toEqual(mockWebhook);
      expect(service.update).toHaveBeenCalledWith('wh-001', dto);
    });
  });

  describe('remove', () => {
    it('should delete a webhook', async () => {
      await controller.remove('wh-001');
      expect(service.remove).toHaveBeenCalledWith('wh-001');
    });
  });

  describe('getDeliveries', () => {
    it('should return delivery history', async () => {
      const result = await controller.getDeliveries('wh-001', {});
      expect(result).toBeDefined();
      expect(service.getDeliveries).toHaveBeenCalledWith('wh-001', {});
    });
  });

  describe('getDelivery', () => {
    it('should return a delivery record', async () => {
      const result = await controller.getDelivery('del-001');
      expect(result).toBeDefined();
      expect(service.getDelivery).toHaveBeenCalledWith('del-001');
    });
  });

  describe('retryDelivery', () => {
    it('should retry a failed delivery', async () => {
      await controller.retryDelivery('wh-001', 'del-001');
      expect(service.retryDelivery).toHaveBeenCalledWith('del-001');
    });
  });

  describe('rotateSecret', () => {
    it('should rotate the webhook secret', async () => {
      const result = await controller.rotateSecret('wh-001');
      expect(result.secret).toBe('new-secret');
      expect(service.rotateSecret).toHaveBeenCalledWith('wh-001');
    });
  });

  describe('revokeSecret', () => {
    it('should revoke the webhook secret', async () => {
      await controller.revokeSecret('wh-001');
      expect(service.revokeSecret).toHaveBeenCalledWith('wh-001');
    });
  });

  describe('getStatus', () => {
    it('should return webhook status', async () => {
      const result = await controller.getStatus('wh-001');
      expect(result.totalDeliveries).toBe(10);
      expect(service.getWebhookStatus).toHaveBeenCalledWith('wh-001');
    });
  });
});

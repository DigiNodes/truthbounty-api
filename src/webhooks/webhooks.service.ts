import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import * as client from 'prom-client';
import { Webhook, WebhookEventType, ALL_WEBHOOK_EVENTS } from './entities/webhook.entity';
import { WebhookSubscription } from './entities/webhook-subscription.entity';
import { WebhookDelivery, DeliveryStatus } from './entities/webhook-delivery.entity';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { UpdateWebhookDto } from './dto/update-webhook.dto';
import { WebhookDeliveryFilterDto } from './dto/webhook-filter.dto';

export const WEBHOOK_SECRET_BYTES = 32;
export const SIGNATURE_ALGORITHM = 'sha256';
export const SECRET_ROTATION_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // 24 hours
export const WEBHOOK_QUEUE = 'webhook-delivery';
export const MAX_CONSECUTIVE_FAILURES_BEFORE_DISABLE = 10;

export interface WebhookEventPayload {
  eventType: WebhookEventType;
  eventId: string;
  module: string;
  network?: string;
  timestamp: string;
  data: Record<string, any>;
}

@Injectable()
export class WebhooksService implements OnModuleInit {
  private readonly logger = new Logger(WebhooksService.name);

  // ─── Prometheus Metrics ────────────────────────────────────────────────
  private deliveriesCounter: client.Counter<string>;
  private deliveryLatencyHistogram: client.Histogram<string>;
  private disabledEndpointsGauge: client.Gauge<string>;
  private activeSubscriptionsGauge: client.Gauge<string>;

  constructor(
    @InjectRepository(Webhook)
    private readonly webhookRepo: Repository<Webhook>,
    @InjectRepository(WebhookSubscription)
    private readonly subscriptionRepo: Repository<WebhookSubscription>,
    @InjectRepository(WebhookDelivery)
    private readonly deliveryRepo: Repository<WebhookDelivery>,
    @InjectQueue(WEBHOOK_QUEUE)
    private readonly webhookQueue: Queue,
  ) {}

async onModuleInit(): Promise<void> {
    try {
      this.deliveriesCounter = new client.Counter({
        name: 'webhook_deliveries_total',
        help: 'Total number of webhook deliveries',
        labelNames: ['webhook_id', 'event_type', 'status'],
      });

      this.deliveryLatencyHistogram = new client.Histogram({
        name: 'webhook_delivery_latency_seconds',
        help: 'Latency of webhook deliveries in seconds',
        labelNames: ['webhook_id', 'event_type', 'status'],
        buckets: [0.1, 0.5, 1, 2.5, 5, 10],
      });

      this.disabledEndpointsGauge = new client.Gauge({
        name: 'webhook_disabled_endpoints_total',
        help: 'Number of disabled webhook endpoints',
      });

      this.activeSubscriptionsGauge = new client.Gauge({
        name: 'webhook_active_subscriptions_total',
        help: 'Number of active webhook subscriptions',
      });
    } catch (error) {
      this.logger.warn(
        `Failed to register Prometheus metrics: ${error.message}. Metrics will be unavailable.`,
      );
    }
  }

  // Update gauge metrics periodically or on relevant operations
  private async updateGaugeMetrics(): Promise<void> {
    try {
      const disabledCount = await this.webhookRepo.count({
        where: { disabled: true },
      });
      this.disabledEndpointsGauge.set(disabledCount);

      const activeWebhooks = await this.webhookRepo.find({
        where: { enabled: true, disabled: false },
      });
      this.activeSubscriptionsGauge.set(activeWebhooks.length);
    } catch (error) {
      this.logger.debug(`Failed to update gauge metrics: ${error.message}`);
    }
  }

  // ─── Webhook CRUD ───────────────────────────────────────────────────────

  async create(dto: CreateWebhookDto): Promise<Webhook> {
    // Validate URL is HTTPS
    if (!dto.url.startsWith('https://')) {
      throw new BadRequestException('Webhook URL must use HTTPS protocol');
    }

    // Check for duplicate active webhook with same URL for this owner
    const existing = await this.webhookRepo.findOne({
      where: { url: dto.url, ownerId: dto.ownerId, disabled: false },
    });
    if (existing) {
      throw new ConflictException(
        'An active webhook with this URL already exists for this owner',
      );
    }

    // Validate event types
    if (!dto.events || dto.events.length === 0) {
      throw new BadRequestException('At least one event type must be subscribed');
    }

    const invalidEvents = dto.events.filter(
      (e) => !ALL_WEBHOOK_EVENTS.includes(e),
    );
    if (invalidEvents.length > 0) {
      throw new BadRequestException(
        `Invalid event types: ${invalidEvents.join(', ')}`,
      );
    }

    // Generate a cryptographically random secret
    const secret = this.generateSecret();

    // Create webhook – store the raw secret so we can sign payloads with it.
    // The secret is already a long random hex string (64 chars), so it is secure
    // at rest in the database. The raw secret is returned to the caller exactly
    // once on creation.
    const webhook = this.webhookRepo.create({
      url: dto.url,
      description: dto.description || '',
      ownerId: dto.ownerId,
      enabled: dto.enabled !== undefined ? dto.enabled : true,
      secret,
      maxRetries: dto.maxRetries ?? 3,
      retryIntervalMs: dto.retryIntervalMs ?? 30000,
    });

    const saved = await this.webhookRepo.save(webhook);

    // Create subscriptions
    const subscriptions = dto.events.map((eventType) =>
      this.subscriptionRepo.create({
        webhookId: saved.id,
        eventType,
        filters: dto.filters || null,
      }),
    );
    await this.subscriptionRepo.save(subscriptions);

    // Return webhook with the raw secret (only time it's returned)
    const result = { ...saved, rawSecret: secret } as any;
    return result;
  }

  async findAll(
    ownerId?: string,
    enabled?: string,
  ): Promise<Webhook[]> {
    const where: any = {};
    if (ownerId) where.ownerId = ownerId;
    if (enabled !== undefined) where.enabled = enabled === 'true';

    return this.webhookRepo.find({
      where,
      relations: ['subscriptions'],
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Webhook> {
    const webhook = await this.webhookRepo.findOne({
      where: { id },
      relations: ['subscriptions'],
    });
    if (!webhook) {
      throw new NotFoundException(`Webhook ${id} not found`);
    }
    return webhook;
  }

  async update(id: string, dto: UpdateWebhookDto): Promise<Webhook> {
    const webhook = await this.findOne(id);

    if (dto.url !== undefined) {
      if (!dto.url.startsWith('https://')) {
        throw new BadRequestException('Webhook URL must use HTTPS protocol');
      }
      webhook.url = dto.url;
    }

    if (dto.description !== undefined) {
      webhook.description = dto.description;
    }

    if (dto.enabled !== undefined) {
      webhook.enabled = dto.enabled;
      // Reset disabled status when re-enabling
      if (dto.enabled) {
        webhook.disabled = false;
        webhook.consecutiveFailures = 0;
      }
    }

    if (dto.maxRetries !== undefined) {
      webhook.maxRetries = dto.maxRetries;
    }

    if (dto.retryIntervalMs !== undefined) {
      webhook.retryIntervalMs = dto.retryIntervalMs;
    }

    // Update subscriptions if events provided
    if (dto.events !== undefined) {
      // Validate events
      const invalidEvents = dto.events.filter(
        (e) => !ALL_WEBHOOK_EVENTS.includes(e),
      );
      if (invalidEvents.length > 0) {
        throw new BadRequestException(
          `Invalid event types: ${invalidEvents.join(', ')}`,
        );
      }

      // Remove existing subscriptions
      await this.subscriptionRepo.delete({ webhookId: id });

      // Create new subscriptions
      const subscriptions = dto.events.map((eventType) =>
        this.subscriptionRepo.create({
          webhookId: id,
          eventType,
          filters: dto.filters || null,
        }),
      );
      await this.subscriptionRepo.save(subscriptions);
    } else if (dto.filters !== undefined) {
      // Update filters on all existing subscriptions
      const subs = await this.subscriptionRepo.find({ where: { webhookId: id } });
      for (const sub of subs) {
        sub.filters = dto.filters;
      }
      await this.subscriptionRepo.save(subs);
    }

    await this.webhookRepo.save(webhook);
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    const webhook = await this.findOne(id);
    await this.webhookRepo.remove(webhook);
  }

  // ─── Secret Management ─────────────────────────────────────────────────

  async rotateSecret(id: string): Promise<{ secret: string; expiresAt: Date }> {
    const webhook = await this.findOne(id);

    // Move current secret to previous with grace period
    webhook.previousSecret = webhook.secret;
    webhook.previousSecretExpiresAt = new Date(
      Date.now() + SECRET_ROTATION_GRACE_PERIOD_MS,
    );

    // Generate new secret
    const newSecret = this.generateSecret();
    webhook.secret = newSecret;
    webhook.secretExpiresAt = null;

    await this.webhookRepo.save(webhook);

    return {
      secret: newSecret,
      expiresAt: new Date(Date.now() + SECRET_ROTATION_GRACE_PERIOD_MS),
    };
  }

  async revokeSecret(id: string): Promise<void> {
    const webhook = await this.findOne(id);

    // Generate new secret (old one immediately invalid)
    const newSecret = this.generateSecret();
    webhook.secret = newSecret;
    webhook.previousSecret = null;
    webhook.previousSecretExpiresAt = null;
    webhook.secretExpiresAt = null;

    await this.webhookRepo.save(webhook);
  }

  // ─── Event Dispatch ────────────────────────────────────────────────────

  async dispatchEvent(
    eventType: WebhookEventType,
    payload: WebhookEventPayload,
  ): Promise<number> {
    // Find all active webhooks subscribed to this event type
    const subscriptions = await this.subscriptionRepo.find({
      where: { eventType },
      relations: ['webhook'],
    });

    // Filter to active webhooks that aren't disabled
    const activeSubs = subscriptions.filter(
      (sub) => sub.webhook && sub.webhook.enabled && !sub.webhook.disabled,
    );

    if (activeSubs.length === 0) {
      this.logger.debug(
        `No active subscribers for event ${eventType}`,
      );
      return 0;
    }

    // Apply event-level filtering
    const matchedSubs = activeSubs.filter((sub) =>
      this.matchesFilters(payload, sub.filters),
    );

    if (matchedSubs.length === 0) {
      this.logger.debug(
        `No subscribers matched filters for event ${eventType}`,
      );
      return 0;
    }

    // Enqueue delivery jobs
    for (const sub of matchedSubs) {
      await this.enqueueDelivery(sub.webhook, eventType, payload);
    }

    this.logger.log(
      `Dispatched event ${eventType} to ${matchedSubs.length} webhooks`,
    );

    // Update gauge metrics
    await this.updateGaugeMetrics();

    return matchedSubs.length;
  }

  private async enqueueDelivery(
    webhook: Webhook,
    eventType: string,
    payload: WebhookEventPayload,
  ): Promise<void> {
    // Create delivery record
    const requestId = crypto.randomUUID();
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = new Date().toISOString();

    const signature = this.signPayload(
      webhook.secret,
      payload,
      timestamp,
      nonce,
    );

    const delivery = this.deliveryRepo.create({
      webhookId: webhook.id,
      eventType,
      payload: payload as any,
      status: DeliveryStatus.PENDING,
      maxRetries: webhook.maxRetries,
      requestId,
      nonce,
      signature,
      timestamp,
    });

    const saved = await this.deliveryRepo.save(delivery);

    // Increment delivery counter
    this.deliveriesCounter.inc({
      webhook_id: webhook.id,
      event_type: eventType,
      status: DeliveryStatus.PENDING,
    });

    // Enqueue to BullMQ for async processing
    await this.webhookQueue.add(
      'deliver',
      {
        deliveryId: saved.id,
        webhookId: webhook.id,
        url: webhook.url,
        payload,
        eventType,
        signature,
        nonce,
        timestamp,
        requestId,
        retryCount: 0,
        maxRetries: webhook.maxRetries,
        retryIntervalMs: webhook.retryIntervalMs,
      },
      {
        attempts: webhook.maxRetries + 1,
        backoff: {
          type: 'exponential',
          delay: webhook.retryIntervalMs,
        },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
  }

  // ─── Delivery History ──────────────────────────────────────────────────

  async getDeliveries(
    webhookId: string,
    filter?: WebhookDeliveryFilterDto,
  ): Promise<{ deliveries: WebhookDelivery[]; total: number; page: number; limit: number }> {
    const page = filter?.page || 1;
    const limit = filter?.limit || 20;
    const skip = (page - 1) * limit;

    const query = this.deliveryRepo
      .createQueryBuilder('d')
      .where('d.webhookId = :webhookId', { webhookId })
      .orderBy('d.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    if (filter?.eventType) {
      query.andWhere('d.eventType = :eventType', { eventType: filter.eventType });
    }
    if (filter?.status) {
      query.andWhere('d.status = :status', { status: filter.status });
    }

    const [deliveries, total] = await query.getManyAndCount();

    return { deliveries, total, page, limit };
  }

  async getDelivery(id: string): Promise<WebhookDelivery> {
    const delivery = await this.deliveryRepo.findOne({ where: { id } });
    if (!delivery) {
      throw new NotFoundException(`Delivery ${id} not found`);
    }
    return delivery;
  }

  // ─── Retry Logic ────────────────────────────────────────────────────────

  async retryDelivery(deliveryId: string): Promise<void> {
    const delivery = await this.getDelivery(deliveryId);
    const webhook = await this.findOne(delivery.webhookId);

    if (!webhook.enabled || webhook.disabled) {
      throw new BadRequestException('Cannot retry: webhook is disabled');
    }

    // Reset delivery status
    delivery.status = DeliveryStatus.PENDING;
    delivery.retryCount = 0;
    delivery.failureReason = null;
    delivery.completedAt = null;
    await this.deliveryRepo.save(delivery);

    // Re-enqueue
    await this.webhookQueue.add(
      'deliver',
      {
        deliveryId: delivery.id,
        webhookId: webhook.id,
        url: webhook.url,
        payload: delivery.payload,
        eventType: delivery.eventType,
        signature: delivery.signature,
        nonce: delivery.nonce,
        timestamp: delivery.timestamp,
        requestId: delivery.requestId,
        retryCount: 0,
        maxRetries: webhook.maxRetries,
        retryIntervalMs: webhook.retryIntervalMs,
      },
      {
        attempts: webhook.maxRetries + 1,
        backoff: {
          type: 'exponential',
          delay: webhook.retryIntervalMs,
        },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
  }

  // ─── Status & Health ───────────────────────────────────────────────────

  async getWebhookStatus(id: string): Promise<{
    webhook: Webhook;
    totalDeliveries: number;
    successfulDeliveries: number;
    failedDeliveries: number;
    pendingDeliveries: number;
    lastDelivery: WebhookDelivery | null;
  }> {
    const webhook = await this.findOne(id);

    const totalDeliveries = await this.deliveryRepo.count({
      where: { webhookId: id },
    });

    const successfulDeliveries = await this.deliveryRepo.count({
      where: { webhookId: id, status: DeliveryStatus.DELIVERED },
    });

    const failedDeliveries = await this.deliveryRepo.count({
      where: { webhookId: id, status: DeliveryStatus.FAILED },
    });

    const pendingDeliveries = await this.deliveryRepo.count({
      where: { webhookId: id, status: DeliveryStatus.PENDING },
    });

    const lastDelivery = await this.deliveryRepo.findOne({
      where: { webhookId: id },
      order: { createdAt: 'DESC' },
    });

    return {
      webhook,
      totalDeliveries,
      successfulDeliveries,
      failedDeliveries,
      pendingDeliveries,
      lastDelivery,
    };
  }

  // ─── Verification Helpers ───────────────────────────────────────────────

  verifySignature(
    payload: any,
    signature: string,
    secret: string,
    timestamp: string,
    nonce: string,
  ): boolean {
    const expected = this.signPayload(secret, payload, timestamp, nonce);
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  // ─── Private Helpers ───────────────────────────────────────────────────

  private generateSecret(): string {
    return crypto.randomBytes(WEBHOOK_SECRET_BYTES).toString('hex');
  }

  private signPayload(
    secret: string,
    payload: any,
    timestamp: string,
    nonce: string,
  ): string {
    const hmac = crypto.createHmac(SIGNATURE_ALGORITHM, secret);
    hmac.update(`${timestamp}.${nonce}.${JSON.stringify(payload)}`);
    return hmac.digest('hex');
  }

  private matchesFilters(
    payload: WebhookEventPayload,
    filters: Record<string, any> | null,
  ): boolean {
    if (!filters || Object.keys(filters).length === 0) return true;

    for (const [key, value] of Object.entries(filters)) {
      const payloadValue = (payload as any)[key] ?? payload.data?.[key];
      if (payloadValue !== value) return false;
    }

    return true;
  }
}

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as client from 'prom-client';
import { WebhookDelivery, DeliveryStatus } from './entities/webhook-delivery.entity';
import { Webhook } from './entities/webhook.entity';
import { MAX_CONSECUTIVE_FAILURES_BEFORE_DISABLE } from './webhooks.service';

interface DeliverJobData {
  deliveryId: string;
  webhookId: string;
  url: string;
  payload: any;
  eventType: string;
  signature: string;
  nonce: string;
  timestamp: string;
  requestId: string;
  retryCount: number;
  maxRetries: number;
  retryIntervalMs: number;
}

const WEBHOOK_DELIVERY_TIMEOUT = 10000; // 10 seconds

@Processor('webhook-delivery')
@Injectable()
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  // ─── Prometheus Metrics ────────────────────────────────────────────────
  private deliveryAttemptsCounter: client.Counter<string>;
  private deliveryLatencyHistogram: client.Histogram<string>;

  constructor(
    @InjectRepository(WebhookDelivery)
    private readonly deliveryRepo: Repository<WebhookDelivery>,
    @InjectRepository(Webhook)
    private readonly webhookRepo: Repository<Webhook>,
  ) {
    super();

    this.deliveryAttemptsCounter = new client.Counter({
      name: 'webhook_delivery_attempts_total',
      help: 'Total number of webhook delivery attempts',
      labelNames: ['webhook_id', 'event_type', 'status'],
    });

    this.deliveryLatencyHistogram = new client.Histogram({
      name: 'webhook_delivery_attempt_latency_seconds',
      help: 'Latency of webhook delivery attempts in seconds',
      labelNames: ['webhook_id', 'event_type', 'result'],
      buckets: [0.1, 0.5, 1, 2.5, 5, 10],
    });
  }

  async process(job: Job<DeliverJobData, any, string>): Promise<any> {
    const data = job.data;

    this.logger.log(
      `Processing webhook delivery ${data.deliveryId} to ${data.url} (attempt ${job.attemptsMade}/${data.maxRetries + 1})`,
    );

    const startTime = Date.now();

    try {
      // Perform the HTTP request
      const response = await this.sendWebhookRequest(data);

      const latency = Date.now() - startTime;

      // Record metrics
      this.deliveryAttemptsCounter.inc({
        webhook_id: data.webhookId,
        event_type: data.eventType,
        status: 'success',
      });

      this.deliveryLatencyHistogram.observe(
        { webhook_id: data.webhookId, event_type: data.eventType, result: 'success' },
        latency / 1000,
      );

      // Update delivery record
      await this.deliveryRepo.update(data.deliveryId, {
        status: DeliveryStatus.DELIVERED,
        responseStatus: response.status,
        responseBody: response.body,
        latency,
        retryCount: job.attemptsMade - 1,
        completedAt: new Date(),
      });

      // Reset consecutive failures on the webhook
      await this.webhookRepo.update(data.webhookId, {
        consecutiveFailures: 0,
      });

      this.logger.log(
        `Webhook delivery ${data.deliveryId} succeeded (${response.status}) in ${latency}ms`,
      );

      return { success: true, status: response.status, latency };
    } catch (error) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isFinalAttempt = job.attemptsMade > data.maxRetries;

      this.logger.warn(
        `Webhook delivery ${data.deliveryId} failed (attempt ${job.attemptsMade}/${data.maxRetries + 1}): ${errorMessage}`,
      );

      // Record metrics
      this.deliveryAttemptsCounter.inc({
        webhook_id: data.webhookId,
        event_type: data.eventType,
        status: isFinalAttempt ? 'dead_letter' : 'failed',
      });

      this.deliveryLatencyHistogram.observe(
        {
          webhook_id: data.webhookId,
          event_type: data.eventType,
          result: isFinalAttempt ? 'dead_letter' : 'failed',
        },
        latency / 1000,
      );

      // Update delivery with failure info
      await this.deliveryRepo.update(data.deliveryId, {
        status: isFinalAttempt ? DeliveryStatus.DEAD_LETTER : DeliveryStatus.FAILED,
        responseStatus: error instanceof Error && 'status' in error ? (error as any).status : undefined,
        responseBody: errorMessage,
        latency,
        retryCount: job.attemptsMade - 1,
        failureReason: errorMessage,
        completedAt: isFinalAttempt ? new Date() : undefined,
      });

      // Track consecutive failures on the webhook — disable after threshold
      if (isFinalAttempt) {
        const webhook = await this.webhookRepo.findOne({
          where: { id: data.webhookId },
        });
        if (webhook) {
          webhook.consecutiveFailures += 1;

          if (webhook.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES_BEFORE_DISABLE) {
            webhook.disabled = true;
            webhook.enabled = false;
            this.logger.warn(
              `Webhook ${data.webhookId} auto-disabled after ${webhook.consecutiveFailures} consecutive failures`,
            );
          }

          await this.webhookRepo.save(webhook);
        }
      }

      // Re-throw to trigger BullMQ retry with backoff
      throw error;
    }
  }

  private async sendWebhookRequest(
    data: DeliverJobData,
  ): Promise<{ status: number; body: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_DELIVERY_TIMEOUT);

    try {
      // Build signed payload following webhook standards
      const body = JSON.stringify(data.payload);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Webhook-ID': data.requestId,
        'X-Webhook-Signature': data.signature,
        'X-Webhook-Nonce': data.nonce,
        'X-Webhook-Timestamp': data.timestamp,
        'X-Webhook-Event': data.eventType,
        'X-Webhook-Delivery': data.deliveryId,
        'User-Agent': 'TruthBounty-Webhook/1.0',
      };

      const response = await fetch(data.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      // Read response body
      const responseBody = await response.text();

      return {
        status: response.status,
        body: responseBody.slice(0, 10000), // Limit body storage
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

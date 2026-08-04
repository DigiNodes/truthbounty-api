import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { Notification } from '../entities/notification.entity';
import { DeliveryResult, DeliveryStatus, WebhookConfig } from '../interfaces/notification.types';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(private readonly redisService: RedisService) {}

  async sendWebhookNotification(
    notification: Notification,
    webhook: WebhookConfig
  ): Promise<DeliveryResult> {
    this.logger.debug(`Sending webhook notification to ${webhook.url} for notification ${notification.id}`);

    try {
      const payload = this.createWebhookPayload(notification);
      const signature = this.generateSignature(JSON.stringify(payload), webhook.secret);
      
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-TruthBounty-Signature': signature,
          'X-TruthBounty-Event': notification.category,
          'User-Agent': 'TruthBounty-Webhook/1.0',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        this.logger.log(`Webhook delivered successfully to ${webhook.url}`);
        return {
          success: true,
          status: DeliveryStatus.DELIVERED,
          deliveredAt: new Date(),
        };
      } else {
        const errorText = await response.text();
        this.logger.error(`Webhook delivery failed with status ${response.status}: ${errorText}`);
        return {
          success: false,
          status: DeliveryStatus.FAILED,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }
    } catch (error) {
      this.logger.error(`Webhook delivery exception for ${webhook.url}`, error);
      return {
        success: false,
        status: DeliveryStatus.FAILED,
        error: error.message,
      };
    }
  }

  private createWebhookPayload(notification: Notification) {
    return {
      id: notification.id,
      eventType: notification.category,
      title: notification.title,
      message: notification.message,
      createdAt: notification.createdAt,
      metadata: notification.metadata,
      userId: notification.userId,
    };
  }

  private generateSignature(payload: string, secret: string): string {
    const hmac = createHmac('sha256', secret);
    hmac.update(payload);
    return `sha256=${hmac.digest('hex')}`;
  }

  verifySignature(payload: string, signature: string, secret: string): boolean {
    const expectedSignature = this.generateSignature(payload, secret);
    return this.timingSafeCompare(expectedSignature, signature);
  }

  private timingSafeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  async getUserWebhooks(userId: string): Promise<WebhookConfig[]> {
    const webhooks = await this.redisService.get(`webhooks:${userId}`);
    return webhooks ? JSON.parse(webhooks) : [];
  }

  async addWebhook(userId: string, webhook: Omit<WebhookConfig, 'id' | 'createdAt' | 'updatedAt'>): Promise<WebhookConfig> {
    const webhooks = await this.getUserWebhooks(userId);
    
    const newWebhook: WebhookConfig = {
      ...webhook,
      id: crypto.randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    
    webhooks.push(newWebhook);
    await this.redisService.set(`webhooks:${userId}`, JSON.stringify(webhooks));
    
    this.logger.log(`New webhook added for user ${userId}: ${webhook.url}`);
    return newWebhook;
  }

  async removeWebhook(userId: string, webhookId: string): Promise<boolean> {
    const webhooks = await this.getUserWebhooks(userId);
    const index = webhooks.findIndex(w => w.id === webhookId);
    
    if (index === -1) return false;
    
    webhooks.splice(index, 1);
    await this.redisService.set(`webhooks:${userId}`, JSON.stringify(webhooks));
    
    this.logger.log(`Webhook ${webhookId} removed for user ${userId}`);
    return true;
  }

  async updateWebhook(userId: string, webhookId: string, updates: Partial<WebhookConfig>): Promise<WebhookConfig | null> {
    const webhooks = await this.getUserWebhooks(userId);
    const webhook = webhooks.find(w => w.id === webhookId);
    
    if (!webhook) return null;
    
    Object.assign(webhook, updates, { updatedAt: new Date() });
    await this.redisService.set(`webhooks:${userId}`, JSON.stringify(webhooks));
    
    this.logger.log(`Webhook ${webhookId} updated for user ${userId}`);
    return webhook;
  }
}
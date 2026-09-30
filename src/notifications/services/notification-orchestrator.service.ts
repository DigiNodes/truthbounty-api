import { Injectable, Logger } from '@nestjs/common';
import { DeliveryChannel } from '../interfaces/notification.types';
import { PreferenceEnforcer } from './preference-enforcer.service';
import { TemplateRenderer, RenderedNotification } from './template-renderer.service';
import { DeliveryTracker } from './delivery-tracker.service';
import { EventType } from '../enums/event-type.enum';
import { NotificationChannel } from '../channels/channel.interface';
import * as crypto from 'crypto';

/**
 * NotificationOrchestrator
 * 
 * High-level orchestration service that:
 * 1. Loads user preferences
 * 2. Renders notification templates
 * 3. Selects delivery channels
 * 4. Enforces constraints (quiet hours, rate limits, etc.)
 * 5. Tracks delivery results
 * 
 * Acts as the coordinator between preference enforcement, templating,
 * and channel delivery.
 */
@Injectable()
export class NotificationOrchestrator {
  private readonly logger = new Logger(NotificationOrchestrator.name);

  // Map of channel implementations injected via DI
  private channels: Map<DeliveryChannel, NotificationChannel> = new Map();

  constructor(
    private preferenceEnforcer: PreferenceEnforcer,
    private templateRenderer: TemplateRenderer,
    private deliveryTracker: DeliveryTracker,
  ) {}

  /**
   * Register a delivery channel implementation
   */
  registerChannel(channel: DeliveryChannel, implementation: NotificationChannel): void {
    this.channels.set(channel, implementation);
    this.logger.log(`Registered delivery channel: ${channel}`);
  }

  /**
   * Orchestrate notification delivery for an event
   * 
   * @param eventType Type of event that triggered notification
   * @param recipientIds User IDs to notify
   * @param metadata Event metadata for templating
   * @returns Results per channel
   */
  async deliverNotification(
    eventType: EventType,
    recipientIds: string[],
    metadata: Record<string, any>,
  ): Promise<
    Record<
      string,
      {
        succeeded: number;
        failed: number;
        skipped: number;
        errors: string[];
      }
    >
  > {
    const results: Record<string, any> = {};

    for (const userId of recipientIds) {
      try {
        await this.deliverToUser(eventType, userId, metadata);
      } catch (error) {
        this.logger.error(
          `Failed to deliver notification to ${userId}: ${error.message}`,
          error.stack,
        );
      }
    }

    return results;
  }

  /**
   * Deliver notification to a single user
   */
  private async deliverToUser(
    eventType: EventType,
    userId: string,
    metadata: Record<string, any>,
  ): Promise<void> {
    this.logger.debug(`Delivering ${eventType} to user ${userId}`);

    // Generate idempotency key for this delivery
    const idempotencyKey = this.generateDeliveryIdempotencyKey(eventType, userId, metadata);

    // Check idempotency (prevent duplicate delivery)
    const shouldProceed = await this.deliveryTracker.checkIdempotency(idempotencyKey);
    if (!shouldProceed) {
      this.logger.debug(`Idempotent delivery suppressed for ${userId}`);
      return;
    }

    // Get user preferences
    const preferences = await this.preferenceEnforcer.getPreferences(userId);

    // Get enabled channels for user
    const enabledChannels = await this.preferenceEnforcer.getEnabledChannels(userId);

    if (enabledChannels.length === 0) {
      this.logger.debug(`User ${userId} has no enabled notification channels`);
      return;
    }

    // Check all constraints
    const shouldDeliver = await this.preferenceEnforcer.shouldDeliver(
      userId,
      eventType,
      enabledChannels[0],
    );

    if (!shouldDeliver.allowed) {
      this.logger.debug(
        `Notification delivery blocked for ${userId}: ${shouldDeliver.reason}`,
      );
      return;
    }

    // Render templates and send via channels
    const deliveryPromises = enabledChannels.map((channel) =>
      this.deliverViaChannel(
        channel,
        userId,
        eventType,
        metadata,
        preferences,
        idempotencyKey,
      ),
    );

    await Promise.allSettled(deliveryPromises);
  }

  /**
   * Deliver via a specific channel
   */
  private async deliverViaChannel(
    channel: DeliveryChannel,
    userId: string,
    eventType: EventType,
    metadata: Record<string, any>,
    preferences: any,
    idempotencyKey: string,
  ): Promise<void> {
    try {
      // Check if channel is enabled
      const isEnabled = await this.preferenceEnforcer.isChannelEnabled(userId, channel);
      if (!isEnabled) {
        this.logger.debug(`Channel ${channel} disabled for user ${userId}`);
        return;
      }

      // Render template for this channel
      const rendered = await this.templateRenderer.render(
        eventType,
        channel,
        metadata,
        preferences.language,
      );

      // Get channel implementation
      const channelImpl = this.channels.get(channel);
      if (!channelImpl) {
        this.logger.warn(`No implementation registered for channel: ${channel}`);
        return;
      }

      // Check if channel config is valid
      const config = await channelImpl.validateConfig(userId);
      if (!config.valid) {
        this.logger.warn(
          `Channel ${channel} config invalid for ${userId}: ${config.errors.join(', ')}`,
        );
        return;
      }

      // Deliver via channel
      this.logger.debug(`Delivering ${eventType} to ${userId} via ${channel}`);
      const result = await channelImpl.send({
        userId,
        channel,
        rendered,
        eventType,
        metadata,
      });

      // Track result
      if (result.success) {
        await this.deliveryTracker.recordDelivery(
          metadata.notificationId || eventType,
          userId,
          channel,
          idempotencyKey,
          { source: 'orchestrator', timestamp: new Date() },
        );
        this.logger.debug(`Delivered ${eventType} to ${userId} via ${channel}`);
      } else {
        await this.deliveryTracker.recordFailure(
          metadata.notificationId || eventType,
          channel,
          result.error || 'Unknown error',
          idempotencyKey,
          0,
          { source: 'orchestrator', timestamp: new Date() },
        );
        this.logger.warn(`Failed to deliver to ${userId} via ${channel}: ${result.error}`);
      }
    } catch (error) {
      this.logger.error(
        `Error during channel delivery (${channel}, ${userId}): ${error.message}`,
        error.stack,
      );

      await this.deliveryTracker.recordFailure(
        metadata.notificationId || eventType,
        channel,
        error.message,
        idempotencyKey,
        0,
        { source: 'orchestrator', errorStack: error.stack },
      );
    }
  }

  /**
   * Generate deterministic idempotency key for user delivery
   */
  private generateDeliveryIdempotencyKey(
    eventType: EventType,
    userId: string,
    metadata: Record<string, any>,
  ): string {
    const combined = `${eventType}:${userId}:${metadata.aggregateId || ''}`;
    return crypto.createHash('sha256').update(combined).digest('hex');
  }

  /**
   * Get list of registered channels
   */
  getRegisteredChannels(): DeliveryChannel[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Check if channel is available
   */
  isChannelAvailable(channel: DeliveryChannel): boolean {
    return this.channels.has(channel);
  }
}

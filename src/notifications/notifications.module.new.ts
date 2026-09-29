import { Module, Logger, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { HttpModule } from '@nestjs/axios';

import { RedisModule } from '../redis/redis.module';
import { OutboxModule } from '../outbox/outbox.module';
import { AuthModule } from '../auth/auth.module';

// Entities
import { Notification } from './entities/notification.entity';
import { NotificationPreference } from './entities/notification-preference.entity';
import { DeliveryHistory } from './entities/delivery-history.entity';
import { NotificationTemplate } from './entities/notification-template.entity';
import { OutboxEvent } from '../outbox/entities/outbox-event.entity';

// Services
import { NotificationEventPublisher } from './services/notification-event-publisher.service';
import { PreferenceEnforcer } from './services/preference-enforcer.service';
import { TemplateRenderer } from './services/template-renderer.service';
import { DeliveryTracker } from './services/delivery-tracker.service';
import { NotificationOrchestrator } from './services/notification-orchestrator.service';
import { NotificationTemplateService } from './services/notification-template.service';
import { NotificationProcessor } from './services/notification-processor.service';
import { OutboxScheduler } from './services/outbox-scheduler.service';
import { RetryStrategy } from './services/retry-strategy.service';
import { NotificationMetricsService } from './services/notification-metrics.service';

// Event Publishers
import { ClaimEventPublisher } from './services/claim-event-publisher.service';
import { VerificationEventPublisher } from './services/verification-event-publisher.service';
import { RewardEventPublisher } from './services/reward-event-publisher.service';
import { GovernanceEventPublisher } from './services/governance-event-publisher.service';

// Channels
import { InAppChannel } from './channels/in-app.channel';
import { EmailChannel } from './channels/email.channel';
import { WebSocketChannel } from './channels/websocket.channel';
import { WebhookChannel } from './channels/webhook.channel';
import { PushChannel } from './channels/push.channel';

// Controllers
import { PreferencesController } from './controllers/preferences.controller';
import { NotificationsQueryController } from './controllers/notifications-query.controller';
import { EventPublisherController } from './controllers/event-publisher.controller';

// Existing services
import { NotificationsService } from './services/notifications.service';

/**
 * NotificationsModule
 * 
 * Comprehensive notification and event delivery system for TruthBounty V2.
 * 
 * Modules:
 * 1. Event Publishing - Protocol event sources
 * 2. Notification Templates - Content generation
 * 3. User Preferences - Subscription management
 * 4. Delivery Channels - Multi-channel delivery
 * 5. Tracking & Delivery History - Audit trail
 * 6. Retry & Error Handling - Reliability
 * 7. Monitoring & Metrics - Observability
 */
@Module({
  imports: [
    // ORM entities
    TypeOrmModule.forFeature([
      Notification,
      NotificationPreference,
      DeliveryHistory,
      NotificationTemplate,
      OutboxEvent,
    ]),

    // Job queue
    BullModule.registerQueue(
      {
        name: 'notifications',
        defaultJobOptions: {
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: {
            age: 3600, // Remove after 1 hour
          },
        },
      },
    ),

    BullBoardModule.forFeature({
      name: 'notifications',
      adapter: BullMQAdapter,
    }),

    // HTTP client
    HttpModule,

    // Dependencies
    RedisModule,
    OutboxModule,
    AuthModule,
  ],

  controllers: [
    PreferencesController,
    NotificationsQueryController,
    EventPublisherController,
  ],

  providers: [
    // Core notification services
    NotificationEventPublisher,
    PreferenceEnforcer,
    TemplateRenderer,
    DeliveryTracker,
    NotificationOrchestrator,
    NotificationTemplateService,
    NotificationProcessor,
    OutboxScheduler,
    RetryStrategy,
    NotificationMetricsService,

    // Delivery channels
    InAppChannel,
    EmailChannel,
    WebSocketChannel,
    WebhookChannel,
    PushChannel,

    // Event publishers (domain-specific)
    ClaimEventPublisher,
    VerificationEventPublisher,
    RewardEventPublisher,
    GovernanceEventPublisher,

    // Existing services
    NotificationsService,
  ],

  exports: [
    // Core services for dependency injection
    NotificationEventPublisher,
    PreferenceEnforcer,
    TemplateRenderer,
    DeliveryTracker,
    NotificationOrchestrator,
    NotificationTemplateService,
    NotificationProcessor,
    OutboxScheduler,
    RetryStrategy,
    NotificationMetricsService,

    // Event publishers
    ClaimEventPublisher,
    VerificationEventPublisher,
    RewardEventPublisher,
    GovernanceEventPublisher,

    // Channels
    InAppChannel,
    EmailChannel,
    WebSocketChannel,
    WebhookChannel,
    PushChannel,

    // Existing exports
    NotificationsService,
  ],
})
export class NotificationsModule implements OnModuleInit {
  private readonly logger = new Logger(NotificationsModule.name);

  constructor(
    private notificationTemplateService: NotificationTemplateService,
    private notificationOrchestrator: NotificationOrchestrator,
    private inAppChannel: InAppChannel,
    private emailChannel: EmailChannel,
    private websocketChannel: WebSocketChannel,
    private webhookChannel: WebhookChannel,
    private pushChannel: PushChannel,
  ) {}

  /**
   * Module initialization - register channels and initialize templates
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('Initializing NotificationsModule...');

    try {
      // Register delivery channels with orchestrator
      this.notificationOrchestrator.registerChannel('IN_APP', this.inAppChannel);
      this.notificationOrchestrator.registerChannel('EMAIL', this.emailChannel);
      this.notificationOrchestrator.registerChannel('WEBSOCKET', this.websocketChannel);
      this.notificationOrchestrator.registerChannel('WEBHOOK', this.webhookChannel);
      this.notificationOrchestrator.registerChannel('PUSH', this.pushChannel);

      // Initialize default templates
      await this.notificationTemplateService.initializeDefaultTemplates();

      this.logger.log('NotificationsModule initialized successfully');
    } catch (error) {
      this.logger.error(
        `Failed to initialize NotificationsModule: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}

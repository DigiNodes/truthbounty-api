import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { LoggerModule } from '../logger/logger.module';
import { MetricsModule } from '../metrics/metrics.module';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../outbox/outbox.module';
import { NotificationsController } from './controllers/notifications.controller';
import { InternalNotificationController } from './controllers/internal-notification.controller';
import { PreferencesController } from './controllers/preferences.controller';
import { NotificationsService } from './services/notifications.service';
import { NotificationPreferencesService } from './services/notification-preferences.service';
import { PreferenceEnforcer } from './services/preference-enforcer.service';
import { WebhookPreferencesService } from './services/webhook-preferences.service';
import { WebhookSecretCipher } from './services/webhook-secret-cipher.service';
import { DeliveryHistoryService } from './services/delivery-history.service';
import { WebSocketService } from './services/websocket.service';
import { NotificationGateway } from './websockets/websocket.gateway';
import { EmailService } from './services/email.service';
import { WebhookService } from './services/webhook.service';
import { NotificationProcessor } from './services/notification.processor';
import { Notification } from './entities/notification.entity';
import { NotificationPreference } from './entities/notification-preference.entity';
import { DeliveryHistory } from './entities/delivery-history.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Notification,
      NotificationPreference,
      DeliveryHistory,
    ]),
    BullModule.registerQueue(
      {
        name: 'notifications',
        defaultJobOptions: {
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
        },
      },
      {
        name: 'dead-letter',
      },
    ),
    BullBoardModule.forFeature({
      name: 'notifications',
      adapter: BullMQAdapter,
    }),
    PrismaModule,
    RedisModule,
    LoggerModule,
    MetricsModule,
    AuthModule,
    OutboxModule,
  ],
  controllers: [
    NotificationsController,
    InternalNotificationController,
    PreferencesController,
  ],
  providers: [
    NotificationsService,
    NotificationPreferencesService,
    PreferenceEnforcer,
    WebhookPreferencesService,
    WebhookSecretCipher,
    DeliveryHistoryService,
    WebSocketService,
    EmailService,
    WebhookService,
    NotificationProcessor,
    NotificationGateway,
  ],
  exports: [
    NotificationsService,
    NotificationPreferencesService,
    PreferenceEnforcer,
    WebhookPreferencesService,
    WebhookSecretCipher,
    DeliveryHistoryService,
    NotificationGateway,
  ],
})
export class NotificationsModule {}

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
import { NotificationsController } from './controllers/notifications.controller';
import { InternalNotificationController } from './controllers/internal-notification.controller';
import { NotificationsService } from './services/notifications.service';
import { NotificationPreferencesService } from './services/notification-preferences.service';
import { DeliveryHistoryService } from './services/delivery-history.service';
import { WebSocketService } from './services/websocket.service';
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
        defaultAttempts: 5,
        defaultBackoff: {
          type: 'exponential',
          delay: 1000,
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
  ],
  controllers: [NotificationsController, InternalNotificationController],
  providers: [
    NotificationsService,
    NotificationPreferencesService,
    DeliveryHistoryService,
    WebSocketService,
    EmailService,
    WebhookService,
    NotificationProcessor,
  ],
  exports: [
    NotificationsService,
    NotificationPreferencesService,
    DeliveryHistoryService,
  ],
})
export class NotificationsModule {}
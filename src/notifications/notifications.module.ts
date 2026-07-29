import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { LoggerModule } from '../logger/logger.module';
import { NotificationsController } from './controllers/notifications.controller';
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
import { MetricsModule } from '../metrics/metrics.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification, NotificationPreference, DeliveryHistory]),
    BullModule.registerQueue({
      name: 'notifications',
      defaultAttempts: 5,
      defaultBackoff: {
        type: 'exponential',
        delay: 1000,
      },
    }),
    BullModule.registerQueue({
      name: 'dead-letter',
    }),
    PrismaModule,
    RedisModule,
    LoggerModule,
    MetricsModule,
    AuthModule,
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationPreferencesService,
    DeliveryHistoryService,
    WebSocketService,
    EmailService,
    WebhookService,
    NotificationProcessor,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
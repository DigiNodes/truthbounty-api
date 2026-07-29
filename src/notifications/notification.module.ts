import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Notification } from './entities/notification.entity';
import { NotificationDeliveryHistory } from './entities/notification.entity';
import { UserNotificationPreferences } from './entities/notification.entity';
import { NotificationService } from './services/notification.service';
import { NotificationProcessor } from './processors/notification.processor';
import { NotificationMetricsService } from './metrics/notification.metrics';
import { WebSocketGateway } from './websockets/websocket.gateway';
import { InAppChannel } from './channels/in-app.channel';
import { WebSocketChannel } from './channels/websocket.channel';
import { EmailChannel } from './channels/email.channel';
import { WebhookChannel } from './channels/webhook.channel';
import { PushChannel } from './channels/push.channel';
import { NotificationController } from './controllers/notification.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Notification,
      NotificationDeliveryHistory,
      UserNotificationPreferences,
    ]),
    BullModule.registerQueue({
      name: 'notifications',
    }),
  ],
  providers: [
    NotificationService,
    NotificationProcessor,
    NotificationMetricsService,
    WebSocketGateway,
    InAppChannel,
    WebSocketChannel,
    EmailChannel,
    WebhookChannel,
    PushChannel,
  ],
  controllers: [NotificationController],
  exports: [NotificationService],
})
export class NotificationModule {}
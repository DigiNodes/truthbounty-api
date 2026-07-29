import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { Notification } from './entities/notification.entity';
import { NotificationDelivery } from './entities/notification-delivery.entity';
import { UserNotificationPreference } from './entities/user-notification-preference.entity';
import { NotificationTemplate } from './entities/notification-template.entity';
import { NotificationController } from './notification.controller';
import { NotificationService } from './services/notification.service';
import { NotificationProcessor } from './notification.processor';
import { TemplateService } from './services/template.service';
import { InAppDeliveryService } from './services/delivery/in-app-delivery.service';
import { EmailDeliveryService } from './services/delivery/email-delivery.service';
import { WebhookDeliveryService } from './services/delivery/webhook-delivery.service';
import { PushDeliveryService } from './services/delivery/push-delivery.service';
import { SmsDeliveryService } from './services/delivery/sms-delivery.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Notification,
      NotificationDelivery,
      UserNotificationPreference,
      NotificationTemplate,
    ]),
    BullModule.registerQueue({
      name: 'notifications-queue',
    }),
    BullBoardModule.forFeature({
      name: 'notifications-queue',
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    NotificationProcessor,
    TemplateService,
    InAppDeliveryService,
    EmailDeliveryService,
    WebhookDeliveryService,
    PushDeliveryService,
    SmsDeliveryService,
  ],
  exports: [
    NotificationService,
    TemplateService,
    BullModule,
  ],
})
export class NotificationModule {}

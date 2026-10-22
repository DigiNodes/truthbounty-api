import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { NotificationTemplateRegistry } from './notification-templates';
import { NotificationRenderer } from './notification-renderer';

@Module({
  imports: [],
  controllers: [NotificationController],
  providers: [
    NotificationTemplateRegistry,
    NotificationRenderer,
    NotificationService,
  ],
  exports: [NotificationService, NotificationTemplateRegistry, NotificationRenderer],
})
export class NotificationModule {}

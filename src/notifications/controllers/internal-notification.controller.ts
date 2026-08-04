import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ServiceAuthGuard } from '../../auth/guards/service-auth.guard';
import { NotificationsService } from '../services/notifications.service';
import { NotificationEvent } from '../interfaces/notification.types';

@Controller('internal/notifications')
@UseGuards(ServiceAuthGuard)
export class InternalNotificationController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * Process a protocol event from another service and convert it to notifications
   * This endpoint is only accessible to internal services with valid service tokens
   */
  @Post('process-event')
  @HttpCode(HttpStatus.ACCEPTED)
  async processProtocolEvent(@Body() event: NotificationEvent) {
    await this.notificationsService.processIncomingEvent(event);
    
    return {
      success: true,
      message: 'Event processing queued',
    };
  }
}
import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ServiceAuthGuard } from '../../auth/guards/service-auth.guard';
import { NotificationService } from '../services/notification.service';
import { ProtocolEventDto } from '../dto/notification.dto';

@Controller('internal/notifications')
@UseGuards(ServiceAuthGuard)
export class InternalNotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  /**
   * Process a protocol event from another service and convert it to a notification
   * This endpoint is only accessible to internal services with valid service tokens
   */
  @Post('process-event')
  @HttpCode(HttpStatus.ACCEPTED)
  async processProtocolEvent(@Body() eventDto: ProtocolEventDto) {
    const { source, eventType, recipientId, payload } = eventDto;
    const notification = await this.notificationService.processProtocolEvent(
      source,
      eventType,
      recipientId,
      payload,
    );
    
    return {
      success: true,
      notificationId: notification.id,
    };
  }
}
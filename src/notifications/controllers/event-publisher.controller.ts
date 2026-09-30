import {
  Controller,
  Post,
  Body,
  UseGuards,
  Logger,
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AdminGuard } from '../../auth/guards/admin.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { NotificationEventPublisher } from '../services/notification-event-publisher.service';
import { PublishEventDto } from '../dto/publish-event.dto';
import { TransactionRunner } from '../../database/transaction.runner';

/**
 * EventPublisherController
 * 
 * Internal API endpoints for publishing protocol events.
 * These endpoints are called by other services (Claims, Verification, Governance, etc.)
 * to trigger notification events.
 * 
 * Access: Internal only (via service-to-service or admin)
 */
@ApiTags('Notifications - Event Publisher (Internal)')
@Controller('api/v2/internal/notifications/events')
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
export class EventPublisherController {
  private readonly logger = new Logger(EventPublisherController.name);

  constructor(
    private eventPublisher: NotificationEventPublisher,
    @Inject() private transactionRunner: TransactionRunner,
  ) {}

  /**
   * Publish a notification event
   * 
   * Internal endpoint called by services to trigger notifications.
   * Must be atomic with the domain event for exactly-once semantics.
   */
  @Post()
  @ApiOperation({ summary: 'Publish notification event' })
  @ApiResponse({
    status: 201,
    description: 'Event published',
    schema: {
      properties: {
        id: { type: 'string' },
        status: { type: 'string' },
        idempotencyKey: { type: 'string' },
      },
    },
  })
  async publishEvent(
    @Body() event: PublishEventDto,
  ): Promise<{ id: string; status: string; idempotencyKey: string }> {
    this.logger.log(`Publishing event: ${event.eventType} to ${event.recipientIds.length} recipients`);

    // Publish within transaction for atomicity
    const result = await this.transactionRunner.run(async (manager) => {
      return this.eventPublisher.publishEvent(event, manager);
    });

    return result;
  }

  /**
   * Batch publish multiple events
   */
  @Post('batch')
  @ApiOperation({ summary: 'Publish multiple events' })
  @ApiResponse({
    status: 201,
    description: 'Events published',
  })
  async publishBatch(
    @Body() events: PublishEventDto[],
  ): Promise<Array<{ id: string; status: string; idempotencyKey: string }>> {
    this.logger.log(`Publishing batch of ${events.length} events`);

    const results = await this.transactionRunner.run(async (manager) => {
      return this.eventPublisher.publishEvents(events, manager);
    });

    return results;
  }

  /**
   * Get event status
   */
  @Post('status/:eventId')
  @ApiOperation({ summary: 'Get event delivery status' })
  async getEventStatus(@CurrentUser('id') userId: string, @Body() { eventId }: { eventId: string }): Promise<any> {
    return this.eventPublisher.getEventStatus(eventId);
  }

  /**
   * Get notification system metrics
   */
  @Post('metrics')
  @ApiOperation({ summary: 'Get event metrics' })
  async getMetrics(): Promise<any> {
    return this.eventPublisher.getMetrics();
  }
}

import {
  Controller,
  Post,
  Body,
  Param,
  Req,
  UseGuards,
  Logger,
  Inject,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { getRuntimeEnvironment } from '../../config/runtime-config';
import {
  NotificationEventPublisher,
  EventStatusCaller,
} from '../services/notification-event-publisher.service';
import { PublishEventDto } from '../dto/publish-event.dto';
import { TransactionRunner } from '../../database/transaction.runner';
import {
  ServiceOrAdminGuard,
  ServiceOrJwtAuthGuard,
  EventPublisherRequest,
} from '../guards/event-publisher-auth.guard';

/**
 * EventPublisherController
 *
 * Internal API endpoints for publishing protocol events.
 * These endpoints are called by other services (Claims, Verification, Governance, etc.)
 * or explicitly authorized admin operators to trigger notification events.
 *
 * Caller Contract:
 * - POST /api/v2/internal/notifications/events              → SERVICE (`x-service-api-key`) or ADMIN (JWT + `@AdminOnly()`)
 * - POST /api/v2/internal/notifications/events/batch        → SERVICE (`x-service-api-key`) or ADMIN (JWT + `@AdminOnly()`)
 * - POST /api/v2/internal/notifications/events/status/:id   → SERVICE, ADMIN, or AUTHN (event owner/recipient only)
 * - POST /api/v2/internal/notifications/events/metrics      → SERVICE (`x-service-api-key`) or ADMIN (JWT + `@AdminOnly()`)
 */
@ApiTags('Notifications - Event Publisher (Internal)')
@Controller('api/v2/internal/notifications/events')
@ApiBearerAuth()
@ApiHeader({
  name: 'x-service-api-key',
  required: false,
  description: 'Internal service-to-service API key (alternative to Admin JWT)',
})
export class EventPublisherController {
  private readonly logger = new Logger(EventPublisherController.name);

  constructor(
    private eventPublisher: NotificationEventPublisher,
    @Inject() private transactionRunner: TransactionRunner,
  ) {}

  /**
   * Publish a notification event.
   *
   * Authorization: SERVICE (`x-service-api-key`) or ADMIN (JWT + `@AdminOnly()`).
   */
  @Post()
  @UseGuards(ServiceOrAdminGuard)
  @AdminOnly()
  @ApiOperation({
    summary: 'Publish notification event',
    description:
      'Internal endpoint for publishing a single notification event. ' +
      'Authorization: SERVICE (x-service-api-key) or ADMIN (JWT + @AdminOnly).',
  })
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
  @ApiResponse({ status: 400, description: 'Invalid event type, recipient list, or payload' })
  @ApiResponse({ status: 401, description: 'Missing or invalid service API key / JWT' })
  @ApiResponse({ status: 403, description: 'Caller lacks admin privileges' })
  async publishEvent(
    @Body() event: PublishEventDto,
  ): Promise<{ id: string; status: string; idempotencyKey: string }> {
    this.eventPublisher.validateEvent(event);
    this.logger.log(
      `Publishing event: ${event.eventType} to ${event.recipientIds.length} recipients`,
    );

    // Publish within transaction for atomicity
    const result = await this.transactionRunner.run(async (manager) => {
      return this.eventPublisher.publishEvent(event, manager);
    });

    return result;
  }

  /**
   * Batch publish multiple events.
   *
   * Authorization: SERVICE (`x-service-api-key`) or ADMIN (JWT + `@AdminOnly()`).
   */
  @Post('batch')
  @UseGuards(ServiceOrAdminGuard)
  @AdminOnly()
  @ApiOperation({
    summary: 'Publish multiple events',
    description:
      'Internal endpoint for atomically publishing a batch of notification events. ' +
      'Authorization: SERVICE (x-service-api-key) or ADMIN (JWT + @AdminOnly).',
  })
  @ApiResponse({
    status: 201,
    description: 'Events published',
  })
  @ApiResponse({ status: 400, description: 'Invalid batch bounds, event types, or recipient lists' })
  @ApiResponse({ status: 401, description: 'Missing or invalid service API key / JWT' })
  @ApiResponse({ status: 403, description: 'Caller lacks admin privileges' })
  async publishBatch(
    @Body() events: PublishEventDto[],
  ): Promise<Array<{ id: string; status: string; idempotencyKey: string }>> {
    this.logger.log(
      `Publishing batch of ${Array.isArray(events) ? events.length : 0} events`,
    );

    const results = await this.transactionRunner.run(async (manager) => {
      return this.eventPublisher.publishEvents(events, manager);
    });

    return results;
  }

  /**
   * Get event delivery status.
   *
   * Authorization: SERVICE, ADMIN, or AUTHN (scoped to event sourceUserId or recipientIds).
   */
  @Post('status/:eventId')
  @UseGuards(ServiceOrJwtAuthGuard)
  @ApiOperation({
    summary: 'Get event delivery status',
    description:
      'Returns delivery status for a notification event. ' +
      'Authorization: SERVICE (x-service-api-key), ADMIN (JWT), or authenticated owner/recipient.',
  })
  @ApiParam({ name: 'eventId', description: 'Outbox event ID' })
  @ApiResponse({ status: 201, description: 'Event delivery status' })
  @ApiResponse({ status: 400, description: 'Missing or invalid eventId' })
  @ApiResponse({ status: 401, description: 'Missing or invalid service API key / JWT' })
  @ApiResponse({ status: 403, description: 'Caller is not authorized to view this event status' })
  async getEventStatus(
    @Param('eventId') paramEventId: string,
    @Req() request: EventPublisherRequest,
    @CurrentUser() currentUser?: EventPublisherRequest['user'],
    @Body() body?: { eventId?: string },
  ): Promise<any> {
    const resolvedEventId = paramEventId || body?.eventId || '';
    const caller = this.resolveStatusCaller(request, currentUser);
    return this.eventPublisher.getEventStatus(resolvedEventId, caller);
  }

  /**
   * Get notification system metrics.
   *
   * Authorization: SERVICE (`x-service-api-key`) or ADMIN (JWT + `@AdminOnly()`).
   */
  @Post('metrics')
  @UseGuards(ServiceOrAdminGuard)
  @AdminOnly()
  @ApiOperation({
    summary: 'Get event metrics',
    description:
      'Internal endpoint for notification outbox metrics. ' +
      'Authorization: SERVICE (x-service-api-key) or ADMIN (JWT + @AdminOnly).',
  })
  @ApiResponse({ status: 201, description: 'Notification event metrics' })
  @ApiResponse({ status: 401, description: 'Missing or invalid service API key / JWT' })
  @ApiResponse({ status: 403, description: 'Caller lacks admin privileges' })
  async getMetrics(): Promise<any> {
    return this.eventPublisher.getMetrics();
  }

  private resolveStatusCaller(
    request: EventPublisherRequest,
    currentUser?: EventPublisherRequest['user'],
  ): EventStatusCaller {
    if (request?.isServiceAuth) {
      return { isService: true };
    }

    const principal = currentUser ?? request?.user ?? request?.use;
    if (!principal) {
      return {};
    }

    const userId =
      principal.userId ?? principal.sub ?? principal.id ?? principal.user?.id;
    const isAdmin = this.isAdminPrincipal(principal);

    return {
      userId,
      isAdmin,
      isService: false,
    };
  }

  private isAdminPrincipal(
    principal: NonNullable<EventPublisherRequest['user']>,
  ): boolean {
    if (
      principal.user?.role === 'admin' ||
      principal.role === 'admin' ||
      (Array.isArray(principal.roles) && principal.roles.includes('admin'))
    ) {
      return true;
    }

    const raw = getRuntimeEnvironment().ADMIN_WALLETS || '';
    if (!raw) {
      return false;
    }

    const adminAddresses = new Set(
      raw
        .split(',')
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean),
    );

    const address = principal.address?.toLowerCase();
    if (address && adminAddresses.has(address)) {
      return true;
    }

    const userId = (principal.userId ?? principal.sub ?? principal.id)?.toLowerCase();
    return Boolean(userId && adminAddresses.has(userId));
  }
}

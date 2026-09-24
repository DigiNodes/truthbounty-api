import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { WebhooksService } from './webhooks.service';
import { Webhook } from './entities/webhook.entity';
import { WebhookDelivery } from './entities/webhook-delivery.entity';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { UpdateWebhookDto } from './dto/update-webhook.dto';
import {
  WebhookDeliveryFilterDto,
  WebhookListFilterDto,
} from './dto/webhook-filter.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('webhooks')
@Controller('webhooks')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  // ─── Registration ──────────────────────────────────────────────────────

  @Post()
  @ApiOperation({
    summary: 'Register a new webhook',
    description:
      'Register a new webhook endpoint with event subscriptions. ' +
      'Returns the webhook details along with the raw secret (shown only once). ' +
      'Store the secret securely to verify incoming webhook signatures.',
  })
  @ApiResponse({
    status: 201,
    description: 'Webhook created successfully',
  })
  @ApiResponse({ status: 400, description: 'Invalid input or non-HTTPS URL' })
  @ApiResponse({ status: 409, description: 'Duplicate webhook URL for this owner' })
  async create(@Body() dto: CreateWebhookDto): Promise<Webhook> {
    return this.webhooksService.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List all webhooks',
    description:
      'Retrieve all registered webhooks with optional filtering by owner or status.',
  })
  @ApiQuery({
    name: 'ownerId',
    required: false,
    description: 'Filter by owner wallet address',
  })
  @ApiQuery({
    name: 'enabled',
    required: false,
    description: 'Filter by enabled status (true/false)',
  })
  async findAll(
    @Query() filter: WebhookListFilterDto,
  ): Promise<Webhook[]> {
    return this.webhooksService.findAll(filter.ownerId, filter.enabled);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get webhook details',
    description: 'Retrieve a specific webhook by ID including its subscriptions.',
  })
  @ApiParam({ name: 'id', description: 'Webhook UUID' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async findOne(@Param('id') id: string): Promise<Webhook> {
    return this.webhooksService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update webhook configuration',
    description:
      'Update webhook URL, description, enabled status, subscriptions, or retry settings.',
  })
  @ApiParam({ name: 'id', description: 'Webhook UUID' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateWebhookDto,
  ): Promise<Webhook> {
    return this.webhooksService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a webhook',
    description:
      'Permanently remove a webhook and all its delivery history.',
  })
  @ApiParam({ name: 'id', description: 'Webhook UUID' })
  @ApiResponse({ status: 204, description: 'Webhook deleted successfully' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async remove(@Param('id') id: string): Promise<void> {
    return this.webhooksService.remove(id);
  }

  // ─── Delivery History ──────────────────────────────────────────────────

  @Get(':id/deliveries')
  @ApiOperation({
    summary: 'Get webhook delivery history',
    description:
      'Retrieve delivery history for a webhook with optional filtering by event type or status.',
  })
  @ApiParam({ name: 'id', description: 'Webhook UUID' })
  async getDeliveries(
    @Param('id') id: string,
    @Query() filter: WebhookDeliveryFilterDto,
  ): Promise<{
    deliveries: WebhookDelivery[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.webhooksService.getDeliveries(id, filter);
  }

  @Get('deliveries/:deliveryId')
  @ApiOperation({
    summary: 'Get delivery details',
    description: 'Retrieve a specific webhook delivery record.',
  })
  @ApiParam({ name: 'deliveryId', description: 'Delivery UUID' })
  @ApiResponse({ status: 404, description: 'Delivery not found' })
  async getDelivery(
    @Param('deliveryId') deliveryId: string,
  ): Promise<WebhookDelivery> {
    return this.webhooksService.getDelivery(deliveryId);
  }

  // ─── Retry ─────────────────────────────────────────────────────────────

  @Post(':id/deliveries/:deliveryId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Retry a failed delivery',
    description:
      'Re-queue a failed webhook delivery for another attempt.',
  })
  @ApiParam({ name: 'id', description: 'Webhook UUID' })
  @ApiParam({ name: 'deliveryId', description: 'Delivery UUID' })
  @ApiResponse({ status: 202, description: 'Retry accepted' })
  async retryDelivery(
    @Param('id') _id: string,
    @Param('deliveryId') deliveryId: string,
  ): Promise<void> {
    return this.webhooksService.retryDelivery(deliveryId);
  }

  // ─── Secret Management ─────────────────────────────────────────────────

  @Post(':id/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate webhook secret',
    description:
      'Generate a new webhook signing secret. The previous secret remains ' +
      'valid for 24 hours to allow seamless transition. Returns the new secret (shown only once).',
  })
  @ApiParam({ name: 'id', description: 'Webhook UUID' })
  async rotateSecret(
    @Param('id') id: string,
  ): Promise<{ secret: string; expiresAt: Date }> {
    return this.webhooksService.rotateSecret(id);
  }

  @Post(':id/revoke-secret')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke webhook secret',
    description:
      'Immediately revoke the current webhook secret and generate a new one. ' +
      'Any deliveries signed with the old secret will be rejected.',
  })
  @ApiParam({ name: 'id', description: 'Webhook UUID' })
  async revokeSecret(@Param('id') id: string): Promise<void> {
    return this.webhooksService.revokeSecret(id);
  }

  // ─── Status ────────────────────────────────────────────────────────────

  @Get(':id/status')
  @ApiOperation({
    summary: 'Get webhook status & metrics',
    description:
      'Retrieve health status and delivery metrics for a webhook, including ' +
      'total deliveries, success/failure counts, and last delivery info.',
  })
  @ApiParam({ name: 'id', description: 'Webhook UUID' })
  async getStatus(
    @Param('id') id: string,
  ): Promise<{
    webhook: Webhook;
    totalDeliveries: number;
    successfulDeliveries: number;
    failedDeliveries: number;
    pendingDeliveries: number;
    lastDelivery: WebhookDelivery | null;
  }> {
    return this.webhooksService.getWebhookStatus(id);
  }
}

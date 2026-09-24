import {
  IsString,
  IsUrl,
  IsOptional,
  IsArray,
  IsBoolean,
  IsNumber,
  Min,
  Max,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { WebhookEventType } from '../entities/webhook.entity';

export class UpdateWebhookDto {
  @ApiPropertyOptional({
    description: 'HTTPS endpoint URL that will receive webhook events',
    example: 'https://api.example.com/webhooks/truthbounty',
  })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_tld: false })
  @IsString()
  url?: string;

  @ApiPropertyOptional({
    description: 'Human-readable description of this webhook',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Whether the webhook is active',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Event types to subscribe to',
    enum: WebhookEventType,
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: WebhookEventType[];

  @ApiPropertyOptional({
    description: 'Optional JSON filters for event payload filtering',
  })
  @IsOptional()
  filters?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Maximum number of retry attempts for failed deliveries',
    default: 3,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  maxRetries?: number;

  @ApiPropertyOptional({
    description: 'Base retry interval in milliseconds',
    default: 30000,
  })
  @IsOptional()
  @IsNumber()
  @Min(1000)
  retryIntervalMs?: number;
}

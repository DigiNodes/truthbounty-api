import {
  IsString,
  IsUrl,
  IsOptional,
  IsArray,
  IsBoolean,
  IsNumber,
  Min,
  Max,
  ArrayNotEmpty,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WebhookEventType } from '../entities/webhook.entity';

export class CreateWebhookDto {
  @ApiProperty({
    description: 'HTTPS endpoint URL that will receive webhook events',
    example: 'https://api.example.com/webhooks/truthbounty',
  })
  @IsUrl({ protocols: ['https'], require_tld: false })
  @IsString()
  url: string;

  @ApiPropertyOptional({
    description: 'Human-readable description of this webhook',
    example: 'Production analytics dashboard',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Blockchain wallet address that owns this webhook',
    example: '0x1234567890abcdef1234567890abcdef12345678',
  })
  @IsString()
  ownerId: string;

  @ApiPropertyOptional({
    description: 'Whether the webhook is active (default: true)',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({
    description: 'Event types to subscribe to',
    example: ['claim.created', 'verification.completed', 'reward.distributed'],
    enum: WebhookEventType,
    isArray: true,
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  events: WebhookEventType[];

  @ApiPropertyOptional({
    description: 'Optional JSON filters for event payload filtering',
    example: { network: 'mainnet', severity: 'high' },
  })
  @IsOptional()
  filters?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Maximum number of retry attempts for failed deliveries (default: 3)',
    default: 3,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  maxRetries?: number;

  @ApiPropertyOptional({
    description: 'Base retry interval in milliseconds (default: 30000)',
    default: 30000,
  })
  @IsOptional()
  @IsNumber()
  @Min(1000)
  retryIntervalMs?: number;
}

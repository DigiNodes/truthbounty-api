import { IsOptional, IsString, IsEnum, IsNumber, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DeliveryStatus } from '../entities/webhook-delivery.entity';

export class WebhookDeliveryFilterDto {
  @ApiPropertyOptional({
    description: 'Filter by event type',
    example: 'claim.created',
  })
  @IsOptional()
  @IsString()
  eventType?: string;

  @ApiPropertyOptional({
    description: 'Filter by delivery status',
    enum: DeliveryStatus,
  })
  @IsOptional()
  @IsEnum(DeliveryStatus)
  status?: DeliveryStatus;

  @ApiPropertyOptional({
    description: 'Page number (1-based)',
    default: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: 'Items per page',
    default: 20,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  limit?: number;
}

export class WebhookListFilterDto {
  @ApiPropertyOptional({
    description: 'Filter by enabled/disabled status',
  })
  @IsOptional()
  @IsString()
  enabled?: string;

  @ApiPropertyOptional({
    description: 'Filter by owner wallet address',
  })
  @IsOptional()
  @IsString()
  ownerId?: string;
}

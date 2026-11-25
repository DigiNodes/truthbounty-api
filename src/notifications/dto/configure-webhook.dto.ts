import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Dedicated write-only webhook configuration request.
 *
 * `secret` is accepted here only. It is never echoed by any response DTO,
 * log, trace or audit record. Omitting it preserves the configured secret.
 */
export class ConfigureWebhookDto {
  @ApiProperty({ description: 'Webhook destination URL' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  url!: string;

  @ApiPropertyOptional({
    description: 'New signing secret. Omit to keep the currently configured secret.',
    writeOnly: true,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  secret?: string;

  @ApiPropertyOptional({ type: [String], description: 'Event types to deliver' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  retryAttempts?: number;

  @ApiPropertyOptional({ description: 'Request timeout in milliseconds' })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(60_000)
  timeout?: number;
}

/** Explicit rotation of an existing webhook signing secret. */
export class RotateWebhookSecretDto {
  @ApiProperty({ description: 'Replacement signing secret', writeOnly: true })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  secret!: string;
}

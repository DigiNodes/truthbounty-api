import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsBoolean,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectionEventType } from '../realtime.enums';

/**
 * Validated input for recording a projection change in the realtime outbox.
 * All inbound client/service input is validated at this boundary before
 * touching the database. Fields are length-capped and required-ish to fail
 * closed on malformed or hostile input.
 */
export class PublishProjectionDto {
  @ApiProperty({ example: 'claim' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  aggregateType: string;

  @ApiProperty({ example: 'claim_abc123' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  aggregateId: string;

  @ApiProperty({ enum: ProjectionEventType })
  @IsEnum(ProjectionEventType)
  eventType: ProjectionEventType;

  @ApiProperty()
  @IsObject()
  payload: Record<string, any>;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  finalized?: boolean;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(128)
  correlationId?: string;
}

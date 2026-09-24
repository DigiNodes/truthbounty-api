import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNumber, IsObject, IsOptional, Max, Min } from 'class-validator';
import { DisputeOutcome } from '../entities/dispute.entity';

export class ResolveDisputeDto {
  @ApiProperty({ enum: DisputeOutcome, description: 'Final dispute outcome' })
  @IsEnum(DisputeOutcome)
  outcome: DisputeOutcome;

  @ApiProperty({ description: 'Confidence score after dispute resolution', minimum: 0, maximum: 1 })
  @IsNumber()
  @Min(0)
  @Max(1)
  finalConfidence: number;

  @ApiPropertyOptional({ description: 'Optional resolution metadata', type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
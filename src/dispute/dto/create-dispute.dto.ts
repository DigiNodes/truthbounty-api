import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';
import { DisputeTrigger } from '../entities/dispute.entity';

export class CreateDisputeDto {
  @ApiProperty({ description: 'Claim identifier' })
  @IsString()
  @IsNotEmpty()
  claimId: string;

  @ApiProperty({ enum: DisputeTrigger, description: 'Reason the dispute was triggered' })
  @IsEnum(DisputeTrigger)
  trigger: DisputeTrigger;

  @ApiProperty({ description: 'Confidence score before dispute resolution', minimum: 0, maximum: 1 })
  @IsNumber()
  @Min(0)
  @Max(1)
  originalConfidence: number;

  @ApiPropertyOptional({ description: 'Optional user identifier for the dispute initiator' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  initiatorId?: string;

  @ApiPropertyOptional({ description: 'Optional dispute metadata', type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
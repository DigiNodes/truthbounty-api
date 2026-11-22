import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CanonicalEventEvidenceDto } from './canonical-event-evidence.dto';

/**
 * Legacy dispute intake. The actor is always the verified JWT principal, and
 * trigger/confidence are never accepted as trusted protocol signals: callers
 * may only point at a canonical DisputeRaised log, from which the server
 * re-derives those values. Without such evidence the record is explicitly
 * non-authoritative workflow metadata.
 *
 * Deprecated fields (`trigger`, `originalConfidence`, `initiatorId`) are
 * ignored if present and are kept out of the schema on purpose.
 */
export class CreateDisputeDto {
  @ApiProperty({ description: 'Claim identifier' })
  @IsString()
  @IsNotEmpty()
  claimId: string;

  @ApiPropertyOptional({
    description:
      'Canonical DisputeRaised log. Omit for an off-chain workflow record.',
    type: CanonicalEventEvidenceDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CanonicalEventEvidenceDto)
  canonicalEvent?: CanonicalEventEvidenceDto;

  @ApiPropertyOptional({
    description: 'Non-authoritative workflow metadata',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CanonicalEventEvidenceDto } from './canonical-event-evidence.dto';

/**
 * projects them from the referenced finalized canonical log. Outcome,
 * confidence, actor and provenance are all re-derived server-side.
 */
export class ProjectDisputeOutcomeDto {
  @ApiProperty({
    description: 'Finalized canonical DisputeResolved / DisputeExpired log',
    type: CanonicalEventEvidenceDto,
  })
  @ValidateNested()
  @Type(() => CanonicalEventEvidenceDto)
  canonicalEvent: CanonicalEventEvidenceDto;

  @ApiPropertyOptional({
    description: 'Additional non-authoritative metadata',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

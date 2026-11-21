import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsObject, IsOptional, ValidateNested } from 'class-validator';
import { CanonicalEventEvidenceDto } from './canonical-event-evidence.dto';

/**
 * A vote is an index of a finalized canonical VoteCast log. Voter, support and
 * weight are re-derived from that event; the request body deliberately has no
 * fields for them.
 */
export class CastVoteDto {
  @ApiProperty({
    description: 'Canonical VoteCast log to project',
    type: CanonicalEventEvidenceDto,
  })
  @ValidateNested()
  @Type(() => CanonicalEventEvidenceDto)
  canonicalEvent: CanonicalEventEvidenceDto;

  @ApiPropertyOptional({ description: 'Additional non-authoritative metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

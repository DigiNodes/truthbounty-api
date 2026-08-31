import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Bounded pagination + deterministic ordering for evidence lists.
 * limit is capped (MAX_LIMIT) to prevent unbounded result sets, matching the
 * repository's established pagination convention.
 */
export const EVIDENCE_PAGE_MAX_LIMIT = 100;
export const EVIDENCE_PAGE_DEFAULT_LIMIT = 20;

export class EvidenceListQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(EVIDENCE_PAGE_MAX_LIMIT)
  limit: number = EVIDENCE_PAGE_DEFAULT_LIMIT;

  @ApiPropertyOptional({ description: 'Filter evidence to a single claim' })
  @IsOptional()
  @IsString()
  claimId?: string;
}

export class EvidenceVersionQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(EVIDENCE_PAGE_MAX_LIMIT)
  limit: number = EVIDENCE_PAGE_DEFAULT_LIMIT;
}

export class EvidenceVersionSelectionDto {
  @ApiPropertyOptional({
    description: 'Specific evidence version to inspect (defaults to latest)',
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;
}

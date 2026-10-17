import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * Bounded pagination + deterministic ordering for evidence lists.
 * limit is capped (MAX_LIMIT) to prevent unbounded result sets, matching the
 * repository's established pagination convention.
 *
 * Cursors are opaque, versioned, and authenticated (see cursor service).
 * Clients must not construct or edit them; the cursor binds position,
 * filters, sort order, route/schema, expiry, and release context.
 */
export const EVIDENCE_PAGE_MAX_LIMIT = 100;
export const EVIDENCE_PAGE_DEFAULT_LIMIT = 20;

// Opaque cursor token format: base64url of signed payload. Bounded length
// prevents amplification and ensures malformed/oversized inputs fail closed.
export const EVIDENCE_CURSOR_PATTERN = /^[A-Za-z0-9_-]{16,4096}$/;

export class EvidenceListQueryDto {
  @ApiPropertyOptional({ description: 'Opaque authenticated pagination cursor (preferred)' })
  @IsOptional()
  @IsString()
  @Matches(EVIDENCE_CURSOR_PATTERN, { message: 'cursor is malformed' })
  cursor?: string;

  @ApiPropertyOptional({ description: 'Legacy offset pagination (deprecated)', deprecated: true, default: 1, minimum: 1 })
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
  @ApiPropertyOptional({ description: 'Opaque authenticated pagination cursor (preferred)' })
  @IsOptional()
  @IsString()
  @Matches(EVIDENCE_CURSOR_PATTERN, { message: 'cursor is malformed' })
  cursor?: string;

  @ApiPropertyOptional({ description: 'Legacy offset pagination (deprecated)', deprecated: true, default: 1, minimum: 1 })
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

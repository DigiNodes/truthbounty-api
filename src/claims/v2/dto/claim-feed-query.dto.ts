import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsInt, Min, Max, IsIn, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';

export const CLAIM_FEED_MAX_LIMIT = 100;
export const CLAIM_FEED_DEFAULT_LIMIT = 20;

export const CLAIM_FEED_STATES = ['PENDING', 'RESOLVED', 'FINALIZED'] as const;
export type ClaimFeedState = (typeof CLAIM_FEED_STATES)[number];

export class ClaimFeedQueryDto {
  @ApiPropertyOptional({
    description: 'Opaque cursor from previous response for stable pagination',
  })
  @IsOptional()
  @IsString()
  cursor?: string | null;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CLAIM_FEED_MAX_LIMIT)
  limit: number = CLAIM_FEED_DEFAULT_LIMIT;

  @ApiPropertyOptional({
    description: 'Filter by lifecycle state',
    enum: CLAIM_FEED_STATES,
  })
  @IsOptional()
  @IsString()
  @IsIn(CLAIM_FEED_STATES)
  state?: ClaimFeedState;

  @ApiPropertyOptional({ description: 'Filter by creator wallet address' })
  @IsOptional()
  @IsString()
  creator?: string;

  @ApiPropertyOptional({
    description: 'Filter claims with effectiveAt >= this date (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    description: 'Filter claims with effectiveAt <= this date (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  to?: string;
}

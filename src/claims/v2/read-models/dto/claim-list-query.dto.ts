import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  CLAIM_READ_MODEL_DEFAULT_LIMIT,
  CLAIM_READ_MODEL_MAX_LIMIT,
  CLAIM_READ_MODEL_STATES,
} from '../claim-read-model.types';

export class ClaimListQuery {
  @ApiPropertyOptional({
    description:
      'Opaque cursor from a previous response. Pins the snapshot and filter set for the walk.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    default: CLAIM_READ_MODEL_DEFAULT_LIMIT,
    minimum: 1,
    maximum: CLAIM_READ_MODEL_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CLAIM_READ_MODEL_MAX_LIMIT)
  limit: number = CLAIM_READ_MODEL_DEFAULT_LIMIT;

  @ApiPropertyOptional({
    description: 'Filter by canonical lifecycle state',
    enum: CLAIM_READ_MODEL_STATES,
  })
  @IsOptional()
  @IsString()
  @IsIn(CLAIM_READ_MODEL_STATES)
  state?: string;

  @ApiPropertyOptional({
    description:
      'Request a specific chain. Must match the served release chain or the request fails closed.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId?: number;

  @ApiPropertyOptional({
    description:
      'Request a specific release. Must match the served release or the request fails closed.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  releaseId?: string;
}

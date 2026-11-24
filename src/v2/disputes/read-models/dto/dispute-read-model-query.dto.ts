import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsInt, Min, Max, IsString } from 'class-validator';

/**
 * Query parameters for the dispute register read model.
 */
export class DisputeListQuery {
  @ApiPropertyOptional({
    description: 'Chain ID to filter by (must match the served release)',
    example: 11155420,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  chainId?: number;

  @ApiPropertyOptional({
    description: 'Release ID to filter by (must match the served release)',
    example: 'release-001',
  })
  @IsOptional()
  @IsString()
  releaseId?: string;

  @ApiPropertyOptional({
    description: 'Dispute status to filter by',
    example: 'raised',
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({
    description: 'Pagination cursor (opaque, base64-encoded)',
    example: 'eyJ2IjoxLCJkaXNwdXRlSWQiOiJhYmM6MTIzIiwic25hcHNob3RBdCI6IjIwMjYtMTAtMThUMTQ6MDA6MDAuMDAwWiIsIm9yZGVyIjoiZGlzcHV0ZUlkOmFzYyIsImNoYWluSWQiOjExMTU1NDIwLCJzdGF0dXMiOm51bGx9',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Maximum number of items to return (1-100)',
    example: 20,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

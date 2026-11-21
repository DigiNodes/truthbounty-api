import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * Query parameters for listing feature flags.
 * Only allows filtering by environment; no access to server-only flags.
 */
export class ListFlagsDto {
  @ApiProperty({
    description: 'Filter flags by environment',
    example: 'production',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Environment must contain only lowercase letters, numbers, and hyphens',
  })
  environment?: string;
}

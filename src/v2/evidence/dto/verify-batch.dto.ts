import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, ArrayMinSize, ArrayMaxSize } from 'class-validator';

/**
 * Request DTO for batch integrity verification.
 */
export class VerifyBatchDto {
  @ApiProperty({
    description: 'Array of evidence IDs to verify',
    example: ['0x123...', '0x456...'],
    type: [String],
    minItems: 1,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100, { message: 'Maximum 100 evidence items per batch' })
  @IsString({ each: true })
  evidenceIds: string[];

  @ApiProperty({
    description: 'Include version-level verification (slower but more comprehensive)',
    example: false,
    required: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  includeVersions?: boolean;
}

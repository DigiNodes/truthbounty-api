import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateDisputeDto {
  @ApiProperty({
    description:
      'Claim to request review of; does not raise an on-chain dispute',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  claimId: string;

  @ApiPropertyOptional({
    description: 'Untrusted workflow metadata; never protocol evidence',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

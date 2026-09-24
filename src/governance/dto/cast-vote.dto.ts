import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CastVoteDto {
  @ApiProperty({ description: 'Voter wallet address' })
  @IsString()
  @IsNotEmpty()
  voter: string;

  @ApiProperty({ description: 'Whether the voter supports the proposal' })
  @IsBoolean()
  support: boolean;

  @ApiPropertyOptional({
    description: 'Voting weight',
    minimum: 0,
    maximum: 1000000,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000)
  weight?: number;

  @ApiPropertyOptional({ description: 'Additional metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

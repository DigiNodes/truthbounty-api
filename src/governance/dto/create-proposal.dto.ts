import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ProposalCategory } from '../entities/proposal.entity';

export class CreateProposalDto {
  @ApiProperty({ description: 'Proposal title' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ description: 'Proposal description' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ description: 'Proposer wallet address' })
  @IsString()
  @IsNotEmpty()
  proposer: string;

  @ApiPropertyOptional({
    enum: ProposalCategory,
    description: 'Proposal category',
  })
  @IsOptional()
  @IsEnum(ProposalCategory)
  category?: ProposalCategory;

  @ApiPropertyOptional({
    description: 'Blockchain transaction hash',
  })
  @IsOptional()
  @IsString()
  blockchainTxHash?: string;

  @ApiPropertyOptional({ description: 'Additional metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

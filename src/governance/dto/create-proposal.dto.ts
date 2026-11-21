import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { ProposalCategory } from '../entities/proposal.entity';
import { CanonicalEventEvidenceDto } from './canonical-event-evidence.dto';

/**
 * Off-chain draft by default. The proposer is always the verified principal
 * from the JWT, never a body field. Supplying canonical ProposalCreated
 * evidence upgrades the row to a chain-bound projection; the client still
 * cannot choose the proposer or the deployment.
 */
export class CreateProposalDto {
  @ApiProperty({ description: 'Proposal title' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ description: 'Proposal description' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiPropertyOptional({
    enum: ProposalCategory,
    description: 'Proposal category',
  })
  @IsOptional()
  @IsEnum(ProposalCategory)
  category?: ProposalCategory;

  @ApiPropertyOptional({
    description:
      'Canonical ProposalCreated log. Omit to create an off-chain draft only.',
    type: CanonicalEventEvidenceDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CanonicalEventEvidenceDto)
  canonicalEvent?: CanonicalEventEvidenceDto;

  @ApiPropertyOptional({ description: 'Additional non-authoritative metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ConfirmationsDto {
  @ApiProperty({ description: 'Current block confirmations for the claim' })
  current: number;

  @ApiProperty({ description: 'Required confirmations for finality' })
  required: number;

  @ApiProperty({ description: 'Whether the claim has reached finality' })
  finalized: boolean;
}

export class ClaimLinksDto {
  @ApiProperty({ description: 'Canonical self URL' })
  self: string;

  @ApiPropertyOptional({ description: 'Evidence collection URL' })
  evidence?: string;

  @ApiPropertyOptional({ description: 'Stakes collection URL' })
  stakes?: string;
}

export class ClaimFeedItemDto {
  @ApiProperty({ description: 'Claim UUID' })
  id: string;

  @ApiProperty({ description: 'Claim title' })
  title: string;

  @ApiProperty({ description: 'Lifecycle state', enum: ['PENDING', 'RESOLVED', 'FINALIZED'] })
  lifecycleState: string;

  @ApiPropertyOptional({ description: 'Confidence score (0-1)' })
  confidenceScore: number | null;

  @ApiPropertyOptional({ description: 'Resolved verdict' })
  resolvedVerdict: boolean | null;

  @ApiPropertyOptional({ description: 'Claim deadline' })
  deadline: Date | null;

  @ApiProperty({ description: 'Effective timestamp for ordering' })
  effectiveAt: Date;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: Date;

  @ApiProperty({ description: 'Confirmation/finality metadata', type: ConfirmationsDto })
  confirmations: ConfirmationsDto;

  @ApiProperty({ description: 'Related resource links', type: ClaimLinksDto })
  links: ClaimLinksDto;
}

export class ClaimFeedPaginationDto {
  @ApiPropertyOptional({ description: 'Cursor for the next page' })
  nextCursor: string | null;

  @ApiProperty({ description: 'Whether more pages exist' })
  hasMore: boolean;
}

export class ClaimFeedResponseDto {
  @ApiProperty({ description: 'List of claims', type: [ClaimFeedItemDto] })
  data: ClaimFeedItemDto[];

  @ApiProperty({ description: 'Pagination metadata', type: ClaimFeedPaginationDto })
  pagination: ClaimFeedPaginationDto;
}

export class ClaimDetailResponseDto {
  @ApiProperty({ description: 'Claim UUID' })
  id: string;

  @ApiProperty({ description: 'Claim title' })
  title: string;

  @ApiProperty({ description: 'Claim content' })
  content: string;

  @ApiPropertyOptional({ description: 'Source URL' })
  source: string | null;

  @ApiPropertyOptional({ description: 'Additional metadata' })
  metadata: Record<string, any> | null;

  @ApiProperty({ description: 'Lifecycle state', enum: ['PENDING', 'RESOLVED', 'FINALIZED'] })
  lifecycleState: string;

  @ApiProperty({ description: 'Confidence score (0-1)' })
  confidenceScore: number | null;

  @ApiPropertyOptional({ description: 'Resolved verdict' })
  resolvedVerdict: boolean | null;

  @ApiPropertyOptional({ description: 'Claim deadline' })
  deadline: Date | null;

  @ApiPropertyOptional({ description: 'First resolution timestamp' })
  resolvedAt: Date | null;

  @ApiProperty({ description: 'Effective timestamp for ordering' })
  effectiveAt: Date;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: Date;

  @ApiProperty({ description: 'Confirmation/finality metadata', type: ConfirmationsDto })
  confirmations: ConfirmationsDto;

  @ApiProperty({ description: 'Related resource links', type: ClaimLinksDto })
  links: ClaimLinksDto;
}

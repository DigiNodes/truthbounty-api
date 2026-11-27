import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ClaimLinksDto {
  @ApiProperty({ description: 'Canonical self URL' })
  self: string;

  @ApiProperty({
    description:
      'Read-only, release-bound canonical claim projection; use this for state and finality',
  })
  canonicalReadModel: string;

  @ApiPropertyOptional({ description: 'Evidence collection URL' })
  evidence?: string;

  @ApiPropertyOptional({ description: 'Stakes collection URL' })
  stakes?: string;

  @ApiPropertyOptional({ description: 'Settlement and reward projection URL' })
  settlement?: string;
}

export class ClaimFeedItemDto {
  @ApiProperty({ description: 'Claim UUID' })
  id: string;

  @ApiProperty({ description: 'Claim title' })
  title: string;

  @ApiPropertyOptional({ description: 'Claim deadline' })
  deadline: Date | null;

  @ApiProperty({ description: 'Effective timestamp for ordering' })
  effectiveAt: Date;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: Date;

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

  @ApiProperty({
    description: 'Pagination metadata',
    type: ClaimFeedPaginationDto,
  })
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

  @ApiPropertyOptional({ description: 'Claim deadline' })
  deadline: Date | null;

  @ApiProperty({ description: 'Effective timestamp for ordering' })
  effectiveAt: Date;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: Date;

  @ApiProperty({ description: 'Related resource links', type: ClaimLinksDto })
  links: ClaimLinksDto;
}

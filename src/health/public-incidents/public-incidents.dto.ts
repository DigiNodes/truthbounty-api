import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Public Incident Projection DTOs (UX-BE-002).
 *
 * Structurally separate from protected administrator incident models:
 * no shared base classes, no spreads, no internal notes, no reporter identities,
 * and no unapproved drafts.
 */

export const PUBLIC_INCIDENTS_SCHEMA_VERSION = 'public-incidents.v1';

export const PUBLIC_INCIDENT_STATUSES = [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
] as const;
export type PublicIncidentStatus = (typeof PUBLIC_INCIDENT_STATUSES)[number];

export const PUBLIC_INCIDENT_IMPACTS = [
  'none',
  'minor',
  'major',
  'critical',
] as const;
export type PublicIncidentImpact = (typeof PUBLIC_INCIDENT_IMPACTS)[number];

export const PUBLIC_INCIDENT_AFFECTED_COMPONENTS = [
  'web',
  'api',
  'rpc',
  'indexer',
  'database',
  'evidence_gateway',
] as const;
export type PublicIncidentComponent =
  (typeof PUBLIC_INCIDENT_AFFECTED_COMPONENTS)[number];

export const PUBLIC_INCIDENT_FRESHNESS = ['fresh', 'stale', 'unknown'] as const;
export type PublicIncidentFreshness =
  (typeof PUBLIC_INCIDENT_FRESHNESS)[number];

export class PublicIncidentLinkDto {
  @ApiProperty({
    description: 'Title or descriptive label of the approved post-incident link',
    example: 'Post-Mortem Analysis Report',
  })
  title: string;

  @ApiProperty({
    description: 'Sanitized public HTTPS link',
    example: 'https://docs.truthbounty.io/reports/inc-2026-10-postmortem',
  })
  url: string;
}

export class PublicIncidentHistoryRecordDto {
  @ApiProperty({
    description: 'Unique audit identifier for this publication event',
    example: 'pub-8f92b7c1-01',
  })
  id: string;

  @ApiProperty({
    enum: PUBLIC_INCIDENT_STATUSES,
    description: 'Status of the incident at the time of this publication update',
    example: 'monitoring',
  })
  status: PublicIncidentStatus;

  @ApiProperty({
    description: 'Sanitized Markdown update message explaining progress or status change',
    example:
      'Database failover completed successfully. All queries are executing normally; monitoring connection latency.',
  })
  message: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Immutable ISO 8601 timestamp when this update was published',
    example: '2026-10-16T12:30:00.000Z',
  })
  publishedAt: string;

  @ApiProperty({
    enum: PUBLIC_INCIDENT_AFFECTED_COMPONENTS,
    isArray: true,
    description: 'Components affected at the time of this update',
    example: ['database', 'api'],
  })
  affectedComponents: PublicIncidentComponent[];
}

export class PublicIncidentSummaryDto {
  @ApiProperty({
    description: 'Unique public incident identifier',
    example: 'inc-9b2f6c01-7e8a-4d2a-a5c3-1289fe943201',
  })
  id: string;

  @ApiProperty({
    description: 'Sanitized public incident title',
    example: 'Database Connection Pool Degradation',
  })
  title: string;

  @ApiProperty({
    enum: PUBLIC_INCIDENT_STATUSES,
    description: 'Current public incident status',
    example: 'resolved',
  })
  status: PublicIncidentStatus;

  @ApiProperty({
    enum: PUBLIC_INCIDENT_IMPACTS,
    description: 'Assessed user-facing impact level',
    example: 'minor',
  })
  impact: PublicIncidentImpact;

  @ApiProperty({
    enum: PUBLIC_INCIDENT_AFFECTED_COMPONENTS,
    isArray: true,
    description: 'Public components affected by this incident',
    example: ['database', 'api'],
  })
  affectedComponents: PublicIncidentComponent[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Immutable ISO 8601 timestamp when the incident started or was observed',
    example: '2026-10-16T11:45:00.000Z',
  })
  startedAt: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Immutable ISO 8601 timestamp of the latest publication event',
    example: '2026-10-16T13:00:00.000Z',
  })
  updatedAt: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Immutable ISO 8601 timestamp when the incident was marked resolved; null if ongoing',
    example: '2026-10-16T13:00:00.000Z',
  })
  resolvedAt: string | null;

  @ApiProperty({
    type: Number,
    description: 'Monotonically increasing sequence number for publication auditability',
    example: 3,
  })
  publicationSequence: number;
}

export class PublicIncidentDetailDto extends PublicIncidentSummaryDto {
  @ApiProperty({
    description: 'Sanitized Markdown narrative describing the incident overview',
    example:
      'We experienced transient query latency spikes on the secondary database pool following an index compaction.',
  })
  description: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Sanitized Markdown summary of mitigations applied or underway',
    example:
      'Query routing was diverted to the primary pool and replica pool connections were recycled.',
  })
  mitigation: string | null;

  @ApiProperty({
    type: [PublicIncidentLinkDto],
    description: 'Approved post-incident documentation and post-mortem links',
  })
  postIncidentLinks: PublicIncidentLinkDto[];

  @ApiProperty({
    type: [PublicIncidentHistoryRecordDto],
    description: 'Chronological publication history with immutable timestamps',
  })
  publicationHistory: PublicIncidentHistoryRecordDto[];
}

export class PublicIncidentPaginationMetaDto {
  @ApiProperty({ description: 'Current page number (1-indexed)', example: 1 })
  page: number;

  @ApiProperty({ description: 'Number of items per page', example: 20 })
  limit: number;

  @ApiProperty({ description: 'Total count of publishable incidents matching filter', example: 1 })
  total: number;

  @ApiProperty({ description: 'Total number of pages', example: 1 })
  totalPages: number;

  @ApiProperty({ description: 'True if a subsequent page exists', example: false })
  hasNext: boolean;

  @ApiProperty({ description: 'True if a preceding page exists', example: false })
  hasPrevious: boolean;
}

export class PublicIncidentListResponseDto {
  @ApiProperty({
    enum: [PUBLIC_INCIDENTS_SCHEMA_VERSION],
    example: PUBLIC_INCIDENTS_SCHEMA_VERSION,
  })
  schemaVersion: typeof PUBLIC_INCIDENTS_SCHEMA_VERSION;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'ISO 8601 timestamp when this projection was generated',
    example: '2026-10-16T12:00:00.000Z',
  })
  generatedAt: string;

  @ApiProperty({
    enum: PUBLIC_INCIDENT_FRESHNESS,
    description: 'Projection freshness indicator (fresh, stale, unknown)',
    example: 'fresh',
  })
  freshness: PublicIncidentFreshness;

  @ApiProperty({
    type: [PublicIncidentSummaryDto],
    description: 'List of published sanitized incident summaries',
  })
  data: PublicIncidentSummaryDto[];

  @ApiProperty({
    type: PublicIncidentPaginationMetaDto,
    description: 'Pagination metadata',
  })
  pagination: PublicIncidentPaginationMetaDto;
}

export class PublicIncidentQueryDto {
  @ApiPropertyOptional({
    description: 'Page number (default 1)',
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Items per page (default 20, max 100)',
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    enum: PUBLIC_INCIDENT_STATUSES,
    description: 'Filter incidents by current status',
  })
  @IsOptional()
  @IsEnum(PUBLIC_INCIDENT_STATUSES)
  status?: PublicIncidentStatus;

  @ApiPropertyOptional({
    enum: PUBLIC_INCIDENT_AFFECTED_COMPONENTS,
    description: 'Filter incidents by affected component',
  })
  @IsOptional()
  @IsEnum(PUBLIC_INCIDENT_AFFECTED_COMPONENTS)
  component?: PublicIncidentComponent;
}

import { ApiProperty } from '@nestjs/swagger';

/**
 * Public service-status projection (UX-BE-001).
 *
 * These DTOs are the ONLY shapes the public status endpoint returns. They are
 * structurally separate from the protected health types in `../health.types`
 * (no shared base classes, no spreads): every field is allow-listed here and
 * populated field-by-field by `projectPublicStatus`.
 */

export const PUBLIC_STATUS_SCHEMA_VERSION = 'public-status.v1';

export const PUBLIC_STATUS_STATES = [
  'operational',
  'degraded',
  'delayed',
  'stale',
  'unavailable',
  'unknown',
] as const;
export type PublicStatusState = (typeof PUBLIC_STATUS_STATES)[number];

export const PUBLIC_COMPONENT_IDS = [
  'web',
  'api',
  'rpc',
  'indexer',
  'database',
  'evidence_gateway',
] as const;
export type PublicComponentId = (typeof PUBLIC_COMPONENT_IDS)[number];

export const PUBLIC_OBSERVATION_SOURCES = [
  'api_self',
  'dependency_probe',
  'web_probe',
  'finalized_cursor',
  'release_config',
  'not_observed',
] as const;
export type PublicObservationSource =
  (typeof PUBLIC_OBSERVATION_SOURCES)[number];

export const PUBLIC_FRESHNESS = ['fresh', 'stale', 'unknown'] as const;
export type PublicFreshness = (typeof PUBLIC_FRESHNESS)[number];

export class PublicObservationDto {
  @ApiProperty({ enum: PUBLIC_OBSERVATION_SOURCES })
  source: PublicObservationSource;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the underlying data was observed; null if never.',
  })
  observedAt: string | null;

  @ApiProperty({ type: Number, nullable: true, minimum: 0 })
  ageSeconds: number | null;

  @ApiProperty({ enum: PUBLIC_FRESHNESS })
  freshness: PublicFreshness;
}

export class PublicComponentStatusDto {
  @ApiProperty({ enum: PUBLIC_COMPONENT_IDS })
  id: PublicComponentId;

  @ApiProperty({ enum: PUBLIC_STATUS_STATES })
  state: PublicStatusState;

  @ApiProperty({ type: PublicObservationDto })
  observation: PublicObservationDto;
}

export class PublicReleaseManifestDto {
  @ApiProperty({ type: String, nullable: true })
  releaseId: string | null;

  @ApiProperty({ type: Number, nullable: true })
  chainId: number | null;

  @ApiProperty({ type: Number, nullable: true })
  deploymentBlock: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'SHA-256 of the published release artifact.',
  })
  artifactChecksum: string | null;

  @ApiProperty({ enum: PUBLIC_STATUS_STATES })
  state: PublicStatusState;

  @ApiProperty({ type: PublicObservationDto })
  observation: PublicObservationDto;
}

export class PublicChainProgressDto {
  @ApiProperty({ type: Number, nullable: true })
  finalizedBlock: number | null;

  @ApiProperty({ type: Number, nullable: true })
  indexedBlock: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'finalizedBlock - indexedBlock.',
  })
  lagBlocks: number | null;

  @ApiProperty({ enum: PUBLIC_STATUS_STATES })
  state: PublicStatusState;

  @ApiProperty({ type: PublicObservationDto })
  observation: PublicObservationDto;
}

export class PublicStatusCacheDto {
  @ApiProperty({ minimum: 0 })
  maxAgeSeconds: number;

  @ApiProperty({
    minimum: 0,
    description: 'Observations older than this are reported as stale.',
  })
  staleAfterSeconds: number;

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;
}

export class PublicStatusResponseDto {
  @ApiProperty({ enum: [PUBLIC_STATUS_SCHEMA_VERSION] })
  schemaVersion: typeof PUBLIC_STATUS_SCHEMA_VERSION;

  @ApiProperty({ format: 'date-time' })
  generatedAt: string;

  @ApiProperty({
    enum: PUBLIC_STATUS_STATES,
    description: 'Worst state across components, release and chain progress.',
  })
  overall: PublicStatusState;

  @ApiProperty({ type: [PublicComponentStatusDto] })
  components: PublicComponentStatusDto[];

  @ApiProperty({ type: PublicReleaseManifestDto })
  release: PublicReleaseManifestDto;

  @ApiProperty({ type: PublicChainProgressDto })
  chain: PublicChainProgressDto;

  @ApiProperty({ type: PublicStatusCacheDto })
  cache: PublicStatusCacheDto;
}

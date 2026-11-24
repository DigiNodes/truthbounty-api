import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DataState } from '../../../../v2/common/data-state.enum';
import {
  CLAIM_READ_MODEL_STATES,
  CLAIM_READ_MODEL_VERSION,
  EVIDENCE_AVAILABILITY_STATES,
} from '../claim-read-model.types';

export class ReleaseProvenanceDto {
  @ApiProperty({
    description: 'Chain the read models are bound to',
    example: 11155420,
  })
  chainId: number;

  @ApiProperty({
    description: 'Canonical release id',
    example: 'rel-opsepolia-20261015-v2',
  })
  releaseId: string;

  @ApiProperty({
    description: 'Deployment block of the release',
    example: 24850000,
  })
  deploymentBlock: number;

  @ApiProperty({
    description: 'Artifact checksum of the release (sha256 hex)',
    example: 'f183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22f',
  })
  artifactChecksum: string;
}

export class ReadModelFreshnessDto {
  @ApiPropertyOptional({
    description: 'Highest projected claim block',
    type: String,
    nullable: true,
  })
  indexedBlock: string | null;

  @ApiPropertyOptional({
    description: 'Chain safe block',
    type: String,
    nullable: true,
  })
  safeBlock: string | null;

  @ApiPropertyOptional({
    description: 'Chain finalized block',
    type: String,
    nullable: true,
  })
  finalizedBlock: string | null;

  @ApiPropertyOptional({
    description: 'Highest block observed from RPC',
    nullable: true,
  })
  observedHead: number | null;

  @ApiPropertyOptional({
    description: 'observedHead - indexedBlock',
    type: String,
    nullable: true,
  })
  lagBlocks: string | null;

  @ApiPropertyOptional({
    description: 'Last checkpoint advance (ISO 8601)',
    nullable: true,
  })
  lastSuccess: string | null;

  @ApiProperty({ description: 'True when the read models must fail closed' })
  stale: boolean;

  @ApiProperty({
    description: 'Machine-readable staleness reasons',
    type: [String],
  })
  staleReasons: string[];

  @ApiProperty({
    description: 'True when the projection is ahead of the observed chain',
  })
  reorgDetected: boolean;
}

export class ClaimListPaginationDto {
  @ApiPropertyOptional({
    description: 'Cursor for the next page',
    nullable: true,
  })
  nextCursor: string | null;

  @ApiProperty({ description: 'Whether more pages exist' })
  hasMore: boolean;

  @ApiProperty({ description: 'Page size applied' })
  limit: number;

  @ApiProperty({ description: 'Deterministic ordering applied' })
  order: string;

  @ApiProperty({ description: 'ISO snapshot pinned for the walk' })
  snapshotAt: string;
}

export class ClaimLastEventDto {
  @ApiProperty({ type: String })
  blockNumber: string;

  @ApiProperty()
  eventIndex: number;

  @ApiProperty()
  txHash: string;

  @ApiProperty({ description: 'ISO 8601 timestamp of the last transition' })
  at: string;
}

export class ClaimDeadlinesDto {
  @ApiPropertyOptional({
    description: 'Verification-round deadline',
    nullable: true,
  })
  verification: string | null;

  @ApiPropertyOptional({ description: 'Appeal-round deadline', nullable: true })
  appeal: string | null;

  @ApiPropertyOptional({
    description: 'Terminal-state timestamp',
    nullable: true,
  })
  settledAt: string | null;
}

export class EvidenceAvailabilityDto {
  @ApiProperty({ enum: EVIDENCE_AVAILABILITY_STATES })
  state: string;

  @ApiProperty()
  activeCount: number;

  @ApiProperty()
  finalizedCount: number;

  @ApiPropertyOptional({ type: String, nullable: true })
  latestBlockNumber: string | null;
}

export class ClaimOutcomeDto {
  @ApiProperty({ enum: ['provisional', 'finalized'] })
  phase: string;

  @ApiPropertyOptional({
    description: 'Non-final outcome; null once finalized',
    nullable: true,
  })
  provisional: { state: string; settledAt: string | null } | null;

  @ApiPropertyOptional({
    description: 'Final outcome; null while provisional',
    nullable: true,
  })
  final: { state: string; settledAt: string | null } | null;
}

export class ClaimReadModelItemDto {
  @ApiProperty()
  claimId: string;

  @ApiProperty()
  chainId: number;

  @ApiProperty({ enum: CLAIM_READ_MODEL_STATES })
  state: string;

  @ApiProperty({ enum: DataState })
  dataState: DataState;

  @ApiProperty({ enum: ['provisional', 'finalized'] })
  phase: string;

  @ApiProperty({ type: ClaimLastEventDto })
  lastEvent: ClaimLastEventDto;

  @ApiProperty({ type: ClaimDeadlinesDto })
  deadlines: ClaimDeadlinesDto;

  @ApiProperty({ type: EvidenceAvailabilityDto })
  evidence: EvidenceAvailabilityDto;

  @ApiProperty({ type: ClaimOutcomeDto })
  outcome: ClaimOutcomeDto;

  @ApiProperty({ type: ReleaseProvenanceDto })
  release: ReleaseProvenanceDto;
}

export class ClaimReadModelListResponseDto {
  @ApiProperty({ enum: ['claim-list'], example: 'claim-list' })
  readModel: string;

  @ApiProperty({ example: CLAIM_READ_MODEL_VERSION })
  readModelVersion: string;

  @ApiProperty({ description: 'ISO 8601 server observation time' })
  observedAt: string;

  @ApiProperty({ type: ReleaseProvenanceDto })
  provenance: ReleaseProvenanceDto;

  @ApiProperty({ type: ReadModelFreshnessDto })
  freshness: ReadModelFreshnessDto;

  @ApiProperty({ type: ClaimListPaginationDto })
  pagination: ClaimListPaginationDto;

  @ApiProperty({ type: [ClaimReadModelItemDto] })
  data: ClaimReadModelItemDto[];
}

export class ClaimReadModelDetailResponseDto {
  @ApiProperty({ enum: ['claim-detail'], example: 'claim-detail' })
  readModel: string;

  @ApiProperty({ example: CLAIM_READ_MODEL_VERSION })
  readModelVersion: string;

  @ApiProperty({ description: 'ISO 8601 server observation time' })
  observedAt: string;

  @ApiProperty({ type: ReleaseProvenanceDto })
  provenance: ReleaseProvenanceDto;

  @ApiProperty({ type: ReadModelFreshnessDto })
  freshness: ReadModelFreshnessDto;

  @ApiProperty({ type: ClaimReadModelItemDto })
  data: ClaimReadModelItemDto;
}

export class ClaimReadModelErrorDto {
  @ApiProperty({
    enum: [
      'STALE_RECONCILIATION',
      'INVALID_ARTIFACT_VERSION',
      'UNSUPPORTED_CHAIN',
      'NOT_FOUND',
    ],
  })
  code: string;

  @ApiProperty()
  message: string;

  @ApiProperty({ enum: [true] })
  failClosed: true;

  @ApiProperty()
  reason: string;

  @ApiPropertyOptional({ nullable: true })
  provenance: ReleaseProvenanceDto | null;
}

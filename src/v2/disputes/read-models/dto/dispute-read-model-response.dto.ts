import { ApiProperty } from '@nestjs/swagger';
import {
  DisputeReadModelListResponse,
  DisputeReadModelDetailResponse,
  DisputeReadModelErrorBody,
  DisputeReadModelItem,
  ReleaseProvenance,
  ReadModelFreshness,
  DisputeListPagination,
  DisputeLastEvent,
  DisputeDeadlines,
  DisputeBond,
  DisputeAppeal,
  DisputeOutcome,
  DisputeTimelineEvent,
  DisputeSettlement,
} from '../dispute-read-model.types';

// ---------------------------------------------------------------------------
// Sub DTOs for Swagger documentation
// ---------------------------------------------------------------------------

class ReleaseProvenanceDto implements ReleaseProvenance {
  @ApiProperty({ example: 11155420 })
  chainId: number;

  @ApiProperty({ example: 'release-001' })
  releaseId: string;

  @ApiProperty({ example: 12345678 })
  deploymentBlock: number;

  @ApiProperty({ example: '0xabc123...' })
  artifactChecksum: string;
}

class ReadModelFreshnessDto implements ReadModelFreshness {
  @ApiProperty({ example: '12345678', nullable: true })
  indexedBlock: string | null;

  @ApiProperty({ example: '12345660', nullable: true })
  safeBlock: string | null;

  @ApiProperty({ example: '12345600', nullable: true })
  finalizedBlock: string | null;

  @ApiProperty({ example: 12345690, nullable: true })
  observedHead: number | null;

  @ApiProperty({ example: '12', nullable: true })
  lagBlocks: string | null;

  @ApiProperty({ example: '2026-10-18T14:00:00Z', nullable: true })
  lastSuccess: string | null;

  @ApiProperty({ example: false })
  stale: boolean;

  @ApiProperty({ example: [], type: [String] })
  staleReasons: string[];

  @ApiProperty({ example: false })
  reorgDetected: boolean;
}

class DisputeLastEventDto implements DisputeLastEvent {
  @ApiProperty({ example: '12345678' })
  blockNumber: string;

  @ApiProperty({ example: 5 })
  eventIndex: number;

  @ApiProperty({ example: '0xabc123...' })
  txHash: string;

  @ApiProperty({ example: '2026-10-18T14:00:00Z' })
  at: string;
}

class DisputeDeadlinesDto implements DisputeDeadlines {
  @ApiProperty({ example: '2026-10-25T14:00:00Z', nullable: true })
  dispute: string | null;

  @ApiProperty({ example: '2026-10-26T14:00:00Z', nullable: true })
  appeal: string | null;

  @ApiProperty({ example: '2026-10-20T14:00:00Z', nullable: true })
  settledAt: string | null;
}

class DisputeBondDto implements DisputeBond {
  @ApiProperty({ example: '1000000000000000000', nullable: true })
  amount: string | null;

  @ApiProperty({ example: '0x...', nullable: true })
  asset: string | null;

  @ApiProperty({ example: 'locked' })
  disposition: 'locked' | 'refunded' | 'slashed' | 'unknown';
}

class DisputeAppealDto implements DisputeAppeal {
  @ApiProperty({ example: true })
  available: boolean;

  @ApiProperty({ example: '0x...', nullable: true })
  appealRoundId: string | null;

  @ApiProperty({ example: 'window_open' })
  reason: 'window_open' | 'deadline_passed' | 'already_final' | 'max_round' | 'no_deadline';
}

class DisputeOutcomeProvisionalDto {
  @ApiProperty({ example: 'raised' })
  status: string;

  @ApiProperty({ example: 'pending', nullable: true })
  outcome: string | null;

  @ApiProperty({ example: '2026-10-25T14:00:00Z', nullable: true })
  deadline: string | null;
}

class DisputeOutcomeFinalDto {
  @ApiProperty({ example: 'resolved' })
  status: 'resolved' | 'expired';

  @ApiProperty({ example: 'overturned', nullable: true })
  outcome: string | null;

  @ApiProperty({ example: '2026-10-20T14:00:00Z', nullable: true })
  settledAt: string | null;
}

class DisputeOutcomeDto implements DisputeOutcome {
  @ApiProperty({ example: 'provisional' })
  phase: 'provisional' | 'appealable' | 'finalized';

  @ApiProperty({ type: DisputeOutcomeProvisionalDto, nullable: true })
  provisional: DisputeOutcomeProvisionalDto | null;

  @ApiProperty({ type: DisputeOutcomeFinalDto, nullable: true })
  final: DisputeOutcomeFinalDto | null;
}

class DisputeTimelineEventDto implements DisputeTimelineEvent {
  @ApiProperty({ example: 'raise' })
  ref: 'raise' | 'resolved' | 'expired';

  @ApiProperty({ example: '0xabc123...' })
  txHash: string;

  @ApiProperty({ example: 5 })
  logIndex: number;

  @ApiProperty({ example: '12345678' })
  blockNumber: string;

  @ApiProperty({ example: '2026-10-18T14:00:00Z' })
  at: string;
}

class DisputeSettlementDto implements DisputeSettlement {
  @ApiProperty({ example: false })
  pending: boolean;

  @ApiProperty({ example: 'PENDING_SETTLEMENT', nullable: true })
  state: string | null;

  @ApiProperty({ example: '500000000000000000', nullable: true })
  rewardAmount: string | null;

  @ApiProperty({ example: '1000000000000000000', nullable: true })
  refundAmount: string | null;

  @ApiProperty({ example: '0', nullable: true })
  slashedAmount: string | null;
}

class DisputeReadModelItemDto implements DisputeReadModelItem {
  @ApiProperty({ example: 'abc:123' })
  disputeId: string;

  @ApiProperty({ example: '0xabc...' })
  claimId: string;

  @ApiProperty({ example: '0xdef...' })
  originalRoundId: string;

  @ApiProperty({ example: 11155420 })
  chainId: number;

  @ApiProperty({ example: 'raised' })
  status: string;

  @ApiProperty({ example: 'finalized' })
  dataState: string;

  @ApiProperty({ example: 'provisional' })
  phase: 'provisional' | 'appealable' | 'finalized';

  @ApiProperty({ type: DisputeLastEventDto })
  lastEvent: DisputeLastEvent;

  @ApiProperty({ type: DisputeDeadlinesDto })
  deadlines: DisputeDeadlines;

  @ApiProperty({ type: DisputeBondDto })
  bond: DisputeBond;

  @ApiProperty({ type: DisputeAppealDto })
  appeal: DisputeAppeal;

  @ApiProperty({ type: DisputeOutcomeDto })
  outcome: DisputeOutcome;

  @ApiProperty({ type: DisputeSettlementDto })
  settlement: DisputeSettlement;

  @ApiProperty({ type: [DisputeTimelineEventDto] })
  timeline: DisputeTimelineEvent[];

  @ApiProperty({ type: ReleaseProvenanceDto })
  release: ReleaseProvenance;
}

class DisputeListPaginationDto implements DisputeListPagination {
  @ApiProperty({ example: 'eyJ2Ijox...', nullable: true })
  nextCursor: string | null;

  @ApiProperty({ example: true })
  hasMore: boolean;

  @ApiProperty({ example: 20 })
  limit: number;

  @ApiProperty({ example: 'disputeId:asc' })
  order: string;

  @ApiProperty({ example: '2026-10-18T14:00:00Z' })
  snapshotAt: string;
}

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

export class DisputeReadModelListResponseDto implements DisputeReadModelListResponse {
  @ApiProperty({ example: 'dispute-register' })
  readModel: string;

  @ApiProperty({ example: 'dispute-read-model/v1' })
  readModelVersion: string;

  @ApiProperty({ example: '2026-10-18T14:00:00Z' })
  observedAt: string;

  @ApiProperty({ type: ReleaseProvenanceDto })
  provenance: ReleaseProvenance;

  @ApiProperty({ type: ReadModelFreshnessDto })
  freshness: ReadModelFreshness;

  @ApiProperty({ type: DisputeListPaginationDto })
  pagination: DisputeListPagination;

  @ApiProperty({ type: [DisputeReadModelItemDto] })
  data: DisputeReadModelItem[];
}

export class DisputeReadModelDetailResponseDto implements DisputeReadModelDetailResponse {
  @ApiProperty({ example: 'dispute-detail' })
  readModel: string;

  @ApiProperty({ example: 'dispute-read-model/v1' })
  readModelVersion: string;

  @ApiProperty({ example: '2026-10-18T14:00:00Z' })
  observedAt: string;

  @ApiProperty({ type: ReleaseProvenanceDto })
  provenance: ReleaseProvenance;

  @ApiProperty({ type: ReadModelFreshnessDto })
  freshness: ReadModelFreshness;

  @ApiProperty({ type: DisputeReadModelItemDto })
  data: DisputeReadModelItem;
}

export class DisputeReadModelErrorDto implements DisputeReadModelErrorBody {
  @ApiProperty({ example: 'STALE_RECONCILIATION' })
  code: string;

  @ApiProperty({ example: 'Dispute read models are not fresh enough to serve' })
  message: string;

  @ApiProperty({ example: true })
  failClosed: true;

  @ApiProperty({ example: 'indexed_block_stale' })
  reason: string;

  @ApiProperty({ type: ReleaseProvenanceDto, nullable: true })
  provenance: Partial<ReleaseProvenance> | null;

  @ApiProperty({ example: { chainId: 11155420 }, nullable: true })
  expected?: Record<string, unknown>;

  @ApiProperty({ example: { chainId: 1 }, nullable: true })
  received?: Record<string, unknown>;
}

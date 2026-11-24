import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import {
  AuthoritySource,
  DuplicationRisk,
  FreshnessState,
  OperationalCapability,
  OperationalImpact,
  OperationalQueueItem,
  OperationalQueueSummary,
  QueueItemStatus,
  RetryDenialReason,
  RetryEligibility,
  RetrySubmission,
  OperationalAuditRecord,
} from './operations.types';

/** One operational queue item. */
export class OperationalQueueItemDto implements OperationalQueueItem {
  @ApiProperty({ description: 'Immutable work identifier.' })
  id: string;

  @ApiProperty({ description: 'Release the work belongs to.' })
  releaseId: string;

  @ApiProperty({ enum: OperationalCapability })
  capability: OperationalCapability;

  @ApiProperty({ enum: AuthoritySource })
  authoritySource: AuthoritySource;

  @ApiProperty({
    nullable: true,
    description: 'ISO timestamp the accepting authority expires, or null.',
  })
  authorityExpiresAt: string | null;

  @ApiProperty({ enum: QueueItemStatus })
  status: QueueItemStatus;

  @ApiProperty({ enum: OperationalImpact })
  impact: OperationalImpact;

  @ApiProperty({ enum: DuplicationRisk })
  duplicationRisk: DuplicationRisk;

  @ApiProperty({ enum: FreshnessState })
  freshness: FreshnessState;

  @ApiProperty()
  attempts: number;

  @ApiProperty()
  maxAttempts: number;

  @ApiProperty({ description: 'Whether the item may be retried right now.' })
  retryable: boolean;

  @ApiProperty({ description: 'Monotonic item version.' })
  version: string;

  @ApiProperty({ description: 'Last time the item changed (ISO).' })
  updatedAt: string;

  @ApiProperty({ description: 'Short, sanitized summary.' })
  summary: string;
}

/** Operational queue summary. */
export class OperationalQueueSummaryDto implements OperationalQueueSummary {
  @ApiProperty()
  releaseId: string;

  @ApiProperty()
  generatedAt: string;

  @ApiProperty()
  total: number;

  @ApiProperty({
    description: 'Counts keyed by QueueItemStatus.',
    example: { pending: 2, completed: 1 },
  })
  countsByStatus: Record<QueueItemStatus, number>;

  @ApiProperty({ type: [OperationalQueueItemDto] })
  items: OperationalQueueItemDto[];
}

/** Retry eligibility for one queue item. */
export class RetryEligibilityDto implements RetryEligibility {
  @ApiProperty()
  id: string;

  @ApiProperty()
  eligible: boolean;

  @ApiProperty({ enum: RetryDenialReason, nullable: true })
  reason: RetryDenialReason | null;

  @ApiProperty()
  attemptsRemaining: number;

  @ApiProperty({
    description:
      'Opaque precondition token to echo as X-Precondition-Token when retrying.',
  })
  preconditionToken: string;
}

/** Accepted retry submission result. */
export class RetrySubmissionDto implements RetrySubmission {
  @ApiProperty()
  id: string;

  @ApiProperty()
  accepted: boolean;

  @ApiProperty({ description: 'Stable audit identifier for this request.' })
  auditId: string;

  @ApiProperty()
  replayed: number;

  @ApiProperty()
  skipped: number;

  @ApiProperty()
  failed: number;

  @ApiProperty({ nullable: true })
  detail: string | null;
}

/** Request body for a retry submission. */
export class SubmitRetryRequestDto {
  @ApiProperty({
    description: 'Precondition token from the retry-eligibility read.',
    example: '0f1e2d3c4b5a6978',
  })
  @IsString()
  @Length(8, 128)
  preconditionToken: string;

  @ApiPropertyOptional({
    description: 'Operator reason, recorded in the audit trail.',
  })
  @IsOptional()
  @IsString()
  @Length(0, 256)
  reason?: string;

  @ApiPropertyOptional({
    description:
      'Force replay of a non-retryable item (requires elevated authority).',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/** Sanitized audit record for a protected request. */
export class OperationalAuditRecordDto implements OperationalAuditRecord {
  @ApiProperty()
  auditId: string;

  @ApiProperty()
  action: string;

  @ApiProperty({ enum: OperationalCapability })
  capability: OperationalCapability;

  @ApiProperty({ enum: AuthoritySource })
  authoritySource: AuthoritySource;

  @ApiProperty({ nullable: true })
  actorId: string | null;

  @ApiProperty({ enum: ['accepted', 'rejected'] })
  outcome: 'accepted' | 'rejected';

  @ApiProperty()
  resultCode: string;

  @ApiProperty({ nullable: true })
  subjectId: string | null;

  @ApiProperty()
  createdAt: string;
}

/** Canonical error envelope for protected operations requests. */
export class CanonicalOperationsErrorDto {
  @ApiProperty({ example: 409 })
  statusCode: number;

  @ApiProperty({
    description: 'Canonical machine-readable code.',
    example: 'STALE_PRECONDITION',
  })
  errorCode: string;

  @ApiProperty()
  message: string;

  @ApiProperty({
    description: 'Stable audit identifier for the rejected request.',
  })
  auditId: string;

  @ApiProperty()
  timestamp: string;
}

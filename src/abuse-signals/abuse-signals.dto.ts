import { ApiProperty } from '@nestjs/swagger';
import {
  ABUSE_CONFIG_VERSION,
  ABUSE_MODEL_VERSION,
  ABUSE_SIGNAL_SCHEMA_VERSION,
} from './abuse-signals.types';

/**
 * Abuse board DTOs (PREWAVE-BE-086, #681).
 *
 * Two visibly different surfaces, deliberately built as separate shapes rather
 * than one shape with optional fields:
 *
 *  - **Admin plane** (`AbuseDecisionAdminDto`) exposes the reason code, its
 *    version, severity and corroboration count. An operator cannot triage
 *    anything else, and a reviewer cannot explain an appeal without them.
 *  - **Subject plane** (`AbuseAppealDto`) exposes only the appellant's own
 *    appeal: its status, its dates, and the text they wrote. It carries **no**
 *    reason code, severity, confidence, sample count or threshold, so a subject
 *    can appeal without being told which heuristic caught them. Publishing the
 *    heuristic would turn every appeal into free red-team feedback.
 *
 * Thresholds and detector internals appear on neither surface.
 */
export const AbuseApiVersions = {
  schema: ABUSE_SIGNAL_SCHEMA_VERSION,
  model: ABUSE_MODEL_VERSION,
  config: ABUSE_CONFIG_VERSION,
} as const;

export class AbuseErrorDto {
  @ApiProperty({ enum: ['BAD_REQUEST', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED', 'STALE_AUTHORITY'] })
  errorCode: string;

  @ApiProperty({ example: 'The request conflicts with the current state.' })
  message: string;
}

/** Admin-plane: one bounded action as stored. */
export class AbuseActionAdminDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ['none', 'observe', 'throttle', 'challenge', 'suspend'] })
  kind: string;

  @ApiProperty({ enum: ['active', 'expired', 'lifted', 'superseded'] })
  status: string;

  @ApiProperty({ example: 'challenge' })
  reasonCode: string;

  @ApiProperty({ example: 1 })
  reasonCodeVersion: number;

  @ApiProperty()
  startedAt: string;

  @ApiProperty({ description: 'Mandatory bound; every action has one.' })
  expiresAt: string;

  @ApiProperty({ example: 1 })
  escalationLevel: number;

  @ApiProperty({ description: 'Always true: every automated action is appealable.' })
  appealable: boolean;
}

/** Admin-plane: one decision, with provenance. */
export class AbuseDecisionAdminDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ description: 'HMAC digest; never a raw identifier.' })
  subjectKey: string;

  @ApiProperty({ enum: ['principal', 'wallet', 'network_prefix'] })
  subjectKind: string;

  @ApiProperty({
    enum: ['no_signal', 'suppressed', 'actioned', 'observed_only', 'indeterminate'],
  })
  outcome: string;

  @ApiProperty({ nullable: true })
  indeterminateReason: string | null;

  @ApiProperty({ nullable: true, description: 'Versioned machine code.' })
  reasonCode: string | null;

  @ApiProperty({ nullable: true })
  reasonCodeVersion: number | null;

  @ApiProperty({ nullable: true })
  severity: string | null;

  @ApiProperty({ example: 0.42 })
  confidence: number;

  @ApiProperty({ example: 640 })
  sampleCount: number;

  @ApiProperty({
    example: 2,
    description: 'Independent dimensions that agreed.',
  })
  corroboratingDimensions: number;

  @ApiProperty({ example: ABUSE_MODEL_VERSION })
  modelVersion: string;

  @ApiProperty({ example: ABUSE_CONFIG_VERSION })
  configVersion: string;

  @ApiProperty({
    nullable: true,
    description: 'Release provenance, all present or all absent.',
  })
  binding: { chainId: number; releaseId: string; deploymentBlock: string; artifactChecksum: string } | null;

  @ApiProperty({ nullable: true, type: AbuseActionAdminDto })
  action: AbuseActionAdminDto | null;

  @ApiProperty()
  decidedAt: string;
}

/**
 * Subject-plane: the appellant's own appeal.
 *
 * Intentionally carries no signal metadata at all.
 */
export class AbuseAppealDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  actionId: string;

  @ApiProperty({ enum: ['pending', 'approved', 'rejected', 'expired'] })
  status: string;

  @ApiProperty()
  submittedAt: string;

  @ApiProperty()
  reviewDueAt: string;

  @ApiProperty({ nullable: true })
  decidedAt: string | null;

  @ApiProperty({ nullable: true })
  decisionNote: string | null;
}

/** Admin-plane: module activation and provenance status. No thresholds. */
export class AbuseStatusAdminDto {
  @ApiProperty({ example: ABUSE_SIGNAL_SCHEMA_VERSION })
  schemaVersion: string;

  @ApiProperty({ example: ABUSE_MODEL_VERSION })
  modelVersion: string;

  @ApiProperty({ example: ABUSE_CONFIG_VERSION })
  configVersion: string;

  @ApiProperty({ description: 'Whether observations are recorded.' })
  detectionEnabled: boolean;

  @ApiProperty({
    description: 'Whether an action may refuse a request. Maintainer-gated.',
  })
  enforcementActive: boolean;

  @ApiProperty({
    description: 'Whether a complete release binding is configured.',
  })
  releaseBound: boolean;

  @ApiProperty({ example: 0 })
  actionsInForce: number;
}

export class SubmitAbuseAppealDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    description: 'Why the decision is believed to be wrong.',
  })
  reason: string;
}

export class DecideAbuseAppealDto {
  @ApiProperty({ description: 'True lifts the action, false records a rejection.' })
  approved: boolean;

  @ApiProperty({ maxLength: 500, required: false })
  note?: string;
}

export class AbuseDecisionListDto {
  @ApiProperty({ type: [AbuseDecisionAdminDto] })
  decisions: AbuseDecisionAdminDto[];

  @ApiProperty({ example: 0 })
  total: number;
}

export class AbuseAppealListDto {
  @ApiProperty({ type: [AbuseAppealDto] })
  appeals: AbuseAppealDto[];
}
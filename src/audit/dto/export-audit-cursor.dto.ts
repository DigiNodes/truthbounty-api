import {
  IsOptional,
  IsString,
  IsEnum,
  IsInt,
  Min,
  Max,
  IsDateString,
  IsUUID,
  IsIn,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  AuditActionType,
  AuditEntityType,
  AuditSeverity,
  AuditCategory,
} from '../entities/audit-log.entity';

/** Maximum rows per page for cursor-based export. */
export const EXPORT_PAGE_SIZE_MAX = 500;

/** Default rows per page. */
export const EXPORT_PAGE_SIZE_DEFAULT = 100;

/** Maximum wall-clock time (ms) the service will spend building a single page. */
export const EXPORT_TIME_LIMIT_MS = 10_000;

/** Maximum total rows that may be exported via a single cursor session. */
export const EXPORT_ROW_LIMIT_TOTAL = 1_000_000;

/** Maximum number of pages a single cursor may produce. */
export const EXPORT_PAGE_LIMIT = 10_000;

/** Cursor TTL in seconds (default 24 h). */
export const EXPORT_CURSOR_TTL_SECONDS = 86_400;

/**
 * Fields explicitly allowed in export output (allowlist).
 *
 * `beforeState`, `afterState`, `metadata`, `ipAddress`, `userAgent`,
 * `walletAddress`, and the raw hash chain fields are intentionally
 * excluded to prevent leaking sensitive or unnecessary personal data.
 */
export const EXPORT_FIELD_ALLOWLIST = [
  'id',
  'eventId',
  'actionType',
  'entityType',
  'entityId',
  'userId',
  'severity',
  'category',
  'source',
  'requestId',
  'description',
  'correlationId',
  'createdAt',
  'chainSequence',
  'integrityHash',
  'previousHash',
  'archived',
] as const;

export type ExportAllowedField = (typeof EXPORT_FIELD_ALLOWLIST)[number];

// ─── Request DTOs ─────────────────────────────────────────────────────────────

/**
 * Query parameters for initiating or continuing a cursor-based export.
 *
 * When `cursorId` is absent a new export session is created.
 * When `cursorId` is present the service continues from the stored position.
 */
export class ExportAuditCursorDto {
  /**
   * Cursor ID returned from a previous page.  Omit to start a new export
   * session.
   */
  @ApiPropertyOptional({
    description: 'Resume token from a previous page response.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID('4')
  cursorId?: string;

  // ── Filters (only honoured when creating a new cursor; ignored on resume) ─

  @ApiPropertyOptional({ enum: AuditEntityType })
  @IsOptional()
  @IsEnum(AuditEntityType)
  entityType?: AuditEntityType;

  @ApiPropertyOptional({ enum: AuditActionType })
  @IsOptional()
  @IsEnum(AuditActionType)
  actionType?: AuditActionType;

  @ApiPropertyOptional({ enum: AuditSeverity })
  @IsOptional()
  @IsEnum(AuditSeverity)
  severity?: AuditSeverity;

  @ApiPropertyOptional({ enum: AuditCategory })
  @IsOptional()
  @IsEnum(AuditCategory)
  category?: AuditCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  /** Page size (1–500). Defaults to 100. */
  @ApiPropertyOptional({ default: EXPORT_PAGE_SIZE_DEFAULT, minimum: 1, maximum: EXPORT_PAGE_SIZE_MAX })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(EXPORT_PAGE_SIZE_MAX)
  limit?: number;

  /** Output format. Defaults to 'json'. */
  @ApiPropertyOptional({ enum: ['json', 'csv'], default: 'json' })
  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';
}

// ─── Response DTOs ────────────────────────────────────────────────────────────

/** A single exported audit log row (allowlisted fields only). */
export class ExportedAuditRow {
  @ApiProperty() id: string;
  @ApiProperty() eventId: string;
  @ApiProperty({ enum: AuditActionType }) actionType: AuditActionType;
  @ApiProperty({ enum: AuditEntityType }) entityType: AuditEntityType;
  @ApiProperty() entityId: string;
  @ApiPropertyOptional() userId: string | null;
  @ApiProperty({ enum: AuditSeverity }) severity: AuditSeverity;
  @ApiProperty({ enum: AuditCategory }) category: AuditCategory;
  @ApiPropertyOptional() source: string | null;
  @ApiPropertyOptional() requestId: string | null;
  @ApiPropertyOptional() description: string | null;
  @ApiPropertyOptional() correlationId: string | null;
  @ApiProperty() createdAt: string;
  @ApiPropertyOptional() chainSequence: number | null;
  @ApiPropertyOptional() integrityHash: string | null;
  @ApiPropertyOptional() previousHash: string | null;
  @ApiProperty() archived: boolean;
}

/** Metadata envelope returned with every page. */
export class ExportCursorMeta {
  @ApiProperty({ description: 'Resume token for the next page.', format: 'uuid' })
  cursorId: string;

  @ApiProperty({ enum: ['active', 'cancelled', 'exhausted', 'expired'] })
  status: string;

  @ApiProperty({ description: 'Rows in this page.' })
  pageCount: number;

  @ApiProperty({ description: 'Total rows exported so far (across all pages).' })
  totalExported: number;

  @ApiProperty({ description: 'Pages fetched including this one.' })
  pagesFetched: number;

  @ApiProperty({ description: 'True when no further pages are available.' })
  exhausted: boolean;

  @ApiProperty({
    description:
      'HMAC-SHA256 of the JSON-serialised rows array in this page. ' +
      'Callers can independently verify this to confirm the page has not ' +
      'been altered in transit.',
  })
  checkpointHash: string;

  @ApiProperty({ description: 'Export format/schema version.' })
  exportVersion: string;

  @ApiProperty({ description: 'Output format of this page.' })
  format: 'json' | 'csv';

  @ApiProperty({ description: 'Cursor hard-expiry timestamp (ISO-8601).' })
  expiresAt: string;

  @ApiProperty({ description: 'Wall-clock time spent building this page (ms).' })
  elapsedMs: number;
}

/** Full response envelope for one cursor-based export page. */
export class ExportCursorResponseDto {
  @ApiProperty()
  success: true;

  /** Allowlisted row data (JSON format). Null when format === 'csv'. */
  @ApiPropertyOptional({ type: [ExportedAuditRow] })
  data: ExportedAuditRow[] | null;

  /**
   * CSV-encoded rows (when format === 'csv').  Null when format === 'json'.
   */
  @ApiPropertyOptional()
  csv: string | null;

  @ApiProperty()
  meta: ExportCursorMeta;

  @ApiProperty()
  timestamp: string;
}

import {
  PUBLIC_INCIDENTS_SCHEMA_VERSION,
  PublicIncidentComponent,
  PublicIncidentDetailDto,
  PublicIncidentFreshness,
  PublicIncidentHistoryRecordDto,
  PublicIncidentImpact,
  PublicIncidentLinkDto,
  PublicIncidentListResponseDto,
  PublicIncidentPaginationMetaDto,
  PublicIncidentStatus,
  PublicIncidentSummaryDto,
} from './public-incidents.dto';
import { sanitizeMarkdown, sanitizeUrl } from './public-incidents.sanitizer';

export interface RawPublicIncidentRecord {
  id: string;
  incidentId?: string | null;
  slug?: string | null;
  title: string;
  status: PublicIncidentStatus;
  impact: PublicIncidentImpact;
  affectedComponents: PublicIncidentComponent[];
  description: string;
  mitigation?: string | null;
  postIncidentLinks?: Array<{ title: string; url: string }> | null;
  publicationHistory?: Array<{
    id: string;
    status: PublicIncidentStatus;
    message: string;
    publishedAt: string;
    affectedComponents: PublicIncidentComponent[];
  }> | null;
  isApproved?: boolean;
  isDraft?: boolean;
  publicationSequence?: number;
  startedAt: Date | string;
  publishedAt?: Date | string | null;
  resolvedAt?: Date | string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface ProjectorPolicy {
  staleAfterSeconds: number;
}

function toIsoString(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Computes freshness given an observation/update timestamp and current time.
 */
export function computeFreshness(
  updatedAt: Date | string | null | undefined,
  now: Date,
  staleAfterSeconds: number,
): PublicIncidentFreshness {
  if (!updatedAt) return 'unknown';
  const updatedTime = new Date(updatedAt).getTime();
  if (Number.isNaN(updatedTime)) return 'unknown';

  const ageSeconds = Math.max(0, Math.floor((now.getTime() - updatedTime) / 1000));
  return ageSeconds > staleAfterSeconds ? 'stale' : 'fresh';
}

/**
 * Projects a raw publishable record to a sanitized PublicIncidentSummaryDto.
 * Returns null if the record is a draft or not approved.
 */
export function projectPublicIncidentSummary(
  raw: RawPublicIncidentRecord,
): PublicIncidentSummaryDto | null {
  // Enforce separation of draft and unapproved records
  if (raw.isDraft === true || raw.isApproved === false) {
    return null;
  }

  const startedAt = toIsoString(raw.startedAt) ?? toIsoString(raw.createdAt) ?? new Date().toISOString();
  const updatedAt =
    toIsoString(raw.publishedAt) ??
    toIsoString(raw.updatedAt) ??
    startedAt;
  const resolvedAt = raw.status === 'resolved' ? toIsoString(raw.resolvedAt) : null;

  return {
    id: String(raw.id),
    title: sanitizeMarkdown(raw.title),
    status: raw.status,
    impact: raw.impact,
    affectedComponents: Array.isArray(raw.affectedComponents) ? [...raw.affectedComponents] : [],
    startedAt,
    updatedAt,
    resolvedAt,
    publicationSequence: raw.publicationSequence ?? 1,
  };
}

/**
 * Projects a raw publishable record to a sanitized PublicIncidentDetailDto.
 * Returns null if the record is a draft or not approved.
 */
export function projectPublicIncidentDetail(
  raw: RawPublicIncidentRecord,
): PublicIncidentDetailDto | null {
  const summary = projectPublicIncidentSummary(raw);
  if (!summary) return null;

  // Sanitize post-incident links: discard invalid/unsafe links
  const postIncidentLinks: PublicIncidentLinkDto[] = [];
  if (Array.isArray(raw.postIncidentLinks)) {
    for (const link of raw.postIncidentLinks) {
      const sanitizedHref = sanitizeUrl(link.url);
      if (sanitizedHref) {
        postIncidentLinks.push({
          title: sanitizeMarkdown(link.title),
          url: sanitizedHref,
        });
      }
    }
  }

  // Sanitize publication history: ensure immutable timestamps and sanitized messages
  const publicationHistory: PublicIncidentHistoryRecordDto[] = [];
  if (Array.isArray(raw.publicationHistory)) {
    for (const item of raw.publicationHistory) {
      const pubAt = toIsoString(item.publishedAt);
      if (pubAt) {
        publicationHistory.push({
          id: String(item.id),
          status: item.status,
          message: sanitizeMarkdown(item.message),
          publishedAt: pubAt,
          affectedComponents: Array.isArray(item.affectedComponents)
            ? [...item.affectedComponents]
            : [],
        });
      }
    }
  }

  return {
    ...summary,
    description: sanitizeMarkdown(raw.description),
    mitigation: raw.mitigation ? sanitizeMarkdown(raw.mitigation) : null,
    postIncidentLinks,
    publicationHistory,
  };
}

/**
 * Projects a paginated list of public incidents into PublicIncidentListResponseDto.
 */
export function projectPublicIncidentList(
  records: RawPublicIncidentRecord[],
  total: number,
  page: number,
  limit: number,
  now: Date,
  policy: ProjectorPolicy,
): PublicIncidentListResponseDto {
  const data: PublicIncidentSummaryDto[] = [];
  let oldestUpdate: Date | null = null;

  for (const record of records) {
    const summary = projectPublicIncidentSummary(record);
    if (summary) {
      data.push(summary);
      const recDate = new Date(summary.updatedAt);
      if (!oldestUpdate || recDate < oldestUpdate) {
        oldestUpdate = recDate;
      }
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const pagination: PublicIncidentPaginationMetaDto = {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  };

  const freshness = data.length === 0
    ? 'fresh'
    : computeFreshness(oldestUpdate, now, policy.staleAfterSeconds);

  return {
    schemaVersion: PUBLIC_INCIDENTS_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    freshness,
    data,
    pagination,
  };
}

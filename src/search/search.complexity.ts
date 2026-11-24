import { BadRequestException } from '@nestjs/common';
import { SearchableEntity, SearchFilter, SortField, PaginationParams, PaginationType } from './search.types';

export const MAX_QUERY_LENGTH = 256;
export const MAX_QUERY_TERMS = 10;
export const MAX_OPERATORS = 5;
export const MAX_WILDCARDS = 2;
export const MAX_PAGE_SIZE = 100;
export const MIN_PAGE_SIZE = 1;
export const MAX_RESULT_WINDOW = 1000;
export const DEFAULT_SEARCH_TIMEOUT_MS = 5000;

export const CLAIMS_SEARCH_FIELDS = ['title', 'content', 'source', 'status', 'finalized'] as const;
export const CLAIMS_FILTER_FIELDS = ['status', 'finalized', 'fromDate', 'toDate', 'owner'] as const;
export const CLAIMS_SORT_FIELDS = [SortField.NEWEST, SortField.OLDEST, SortField.RELEVANCE, SortField.REWARD];

export const DISPUTES_SEARCH_FIELDS = ['status', 'trigger'] as const;
export const DISPUTES_FILTER_FIELDS = ['status', 'fromDate', 'toDate'] as const;
export const DISPUTES_SORT_FIELDS = [SortField.NEWEST, SortField.OLDEST, SortField.RELEVANCE];

export const USERS_SEARCH_FIELDS = ['walletAddress'] as const;
export const USERS_FILTER_FIELDS = ['walletAddress'] as const;
export const USERS_SORT_FIELDS = [SortField.NEWEST, SortField.OLDEST, SortField.RELEVANCE, SortField.REPUTATION];

export const FORBIDDEN_PRIVATE_FIELDS = [
  'role',
  'wallets',
  'email',
  'password',
  'hash',
  'secret',
  'nonce',
  'apiKey',
  'token',
  'admin',
  'permissions',
  'metadata',
  'worldcoinVerifiedAt',
] as const;

export interface SanitizedQuery {
  raw: string;
  normalized: string;
  terms: string[];
  fieldTerms: Map<string, string>;
}

/**
 * Validates search query complexity, bounded operators, wildcards, length, and field syntax.
 */
export function validateAndSanitizeQuery(
  query: string | undefined | null,
  entity?: SearchableEntity | 'global',
): SanitizedQuery {
  if (query === undefined || query === null || query.trim() === '') {
    return {
      raw: '',
      normalized: '',
      terms: [],
      fieldTerms: new Map(),
    };
  }

  // Null byte injection check
  if (query.includes('\0')) {
    throw new BadRequestException('Search query contains invalid characters (null byte)');
  }

  // Huge query length check
  if (query.length > MAX_QUERY_LENGTH) {
    throw new BadRequestException(
      `Search query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`,
    );
  }

  // Canonical Unicode NFC normalization
  const normalized = query.normalize('NFC').trim();

  // Control characters check (ASCII 0-31 except space, and 127)
  if (/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(normalized)) {
    throw new BadRequestException('Search query contains invalid control characters');
  }

  // Wildcard abuse checks
  if (/[%_*]{2,}/.test(normalized)) {
    throw new BadRequestException(
      'Wildcard abuse detected: consecutive wildcards are not permitted',
    );
  }

  const wildcards = normalized.match(/[%_*]/g);
  if (wildcards && wildcards.length > MAX_WILDCARDS) {
    throw new BadRequestException(
      `Wildcard abuse detected: maximum ${MAX_WILDCARDS} wildcards permitted`,
    );
  }

  if (/^[%_*\s]+$/.test(normalized)) {
    throw new BadRequestException('Search query cannot consist solely of wildcards');
  }

  // Field-specific search operator check (e.g. "role:admin", "password:secret")
  const fieldMatches = normalized.matchAll(/(?:^|\s)([a-zA-Z0-9_]+):([^\s]+)/g);
  const fieldTerms = new Map<string, string>();
  for (const match of fieldMatches) {
    const field = match[1];
    const value = match[2];

    // Explicitly reject private/forbidden fields
    if (FORBIDDEN_PRIVATE_FIELDS.includes(field as any)) {
      throw new BadRequestException(
        `Unapproved/private field "${field}" is not searchable`,
      );
    }

    // Verify field is approved for entity or global
    const isApproved = isFieldApprovedForEntity(field, entity ?? 'global');
    if (!isApproved) {
      throw new BadRequestException(
        `Unapproved/private field "${field}" is not searchable`,
      );
    }
    fieldTerms.set(field, value);
  }

  // Bounded operators check (AND, OR, NOT, quotes)
  const booleanOpMatches = normalized.match(/\b(AND|OR|NOT)\b/gi) || [];
  const quoteMatches = normalized.match(/"/g) || [];
  const totalOperators = booleanOpMatches.length + Math.floor(quoteMatches.length / 2) + fieldTerms.size;
  if (totalOperators > MAX_OPERATORS) {
    throw new BadRequestException(
      `Search query exceeds maximum allowed operators (max ${MAX_OPERATORS})`,
    );
  }

  // Extract search terms (stripping field:value and boolean operators)
  let cleanTermsStr = normalized
    .replace(/(?:^|\s)[a-zA-Z0-9_]+:[^\s]+/g, ' ')
    .replace(/\b(AND|OR|NOT)\b/gi, ' ')
    .replace(/["']/g, ' ')
    .trim();

  const terms = cleanTermsStr.split(/\s+/).filter(Boolean);

  // Term count check
  if (terms.length > MAX_QUERY_TERMS) {
    throw new BadRequestException(
      `Search query exceeds maximum allowed terms (max ${MAX_QUERY_TERMS})`,
    );
  }

  return {
    raw: query,
    normalized,
    terms,
    fieldTerms,
  };
}

function isFieldApprovedForEntity(field: string, entity: SearchableEntity | 'global'): boolean {
  if (entity === 'claims') {
    return CLAIMS_SEARCH_FIELDS.includes(field as any);
  }
  if (entity === 'disputes') {
    return DISPUTES_SEARCH_FIELDS.includes(field as any);
  }
  if (entity === 'users') {
    return USERS_SEARCH_FIELDS.includes(field as any);
  }
  // Global
  return (
    CLAIMS_SEARCH_FIELDS.includes(field as any) ||
    DISPUTES_SEARCH_FIELDS.includes(field as any) ||
    USERS_SEARCH_FIELDS.includes(field as any)
  );
}

/**
 * Escapes characters with special meaning in SQL LIKE queries (%, _, \)
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

/**
 * Validates filter fields for given entity
 */
export function validateFilters(
  entity: SearchableEntity | 'global',
  filters: SearchFilter,
): void {
  if (filters.fromDate && isNaN(Date.parse(filters.fromDate))) {
    throw new BadRequestException('Invalid fromDate filter');
  }
  if (filters.toDate && isNaN(Date.parse(filters.toDate))) {
    throw new BadRequestException('Invalid toDate filter');
  }
  if (filters.fromDate && filters.toDate) {
    if (new Date(filters.fromDate) > new Date(filters.toDate)) {
      throw new BadRequestException('fromDate cannot be after toDate');
    }
  }

  if (entity === 'global') {
    return;
  }

  if (entity === 'claims') {
    if (filters.walletAddress) {
      throw new BadRequestException('Filter walletAddress is not allowed for entity claims');
    }
  } else if (entity === 'disputes') {
    if (filters.finalized !== undefined) {
      throw new BadRequestException('Filter finalized is not allowed for entity disputes');
    }
    if (filters.walletAddress) {
      throw new BadRequestException('Filter walletAddress is not allowed for entity disputes');
    }
  } else if (entity === 'users') {
    if (filters.status) {
      throw new BadRequestException('Filter status is not allowed for entity users');
    }
    if (filters.finalized !== undefined) {
      throw new BadRequestException('Filter finalized is not allowed for entity users');
    }
    if (filters.fromDate || filters.toDate) {
      throw new BadRequestException('Date range filters are not allowed for entity users');
    }
  }
}

/**
 * Validates sort field for target entity
 */
export function validateSort(
  entity: SearchableEntity | 'global',
  sort: SortField,
): void {
  if (entity === 'claims') {
    if (!CLAIMS_SORT_FIELDS.includes(sort)) {
      throw new BadRequestException(
        `Sort field ${sort} is not supported for claims search`,
      );
    }
  } else if (entity === 'disputes') {
    if (!DISPUTES_SORT_FIELDS.includes(sort)) {
      throw new BadRequestException(
        `Sort field ${sort} is not supported for disputes search`,
      );
    }
  } else if (entity === 'users') {
    if (!USERS_SORT_FIELDS.includes(sort)) {
      throw new BadRequestException(
        `Sort field ${sort} is not supported for users search`,
      );
    }
  }
}

/**
 * Validates pagination parameters and bounds result window
 */
export function validatePagination(pagination: PaginationParams): void {
  if (pagination.page !== undefined && pagination.page < 1) {
    throw new BadRequestException('Page must be greater than or equal to 1');
  }
  if (pagination.limit !== undefined) {
    if (pagination.limit < MIN_PAGE_SIZE || pagination.limit > MAX_PAGE_SIZE) {
      throw new BadRequestException(
        `Limit must be between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}`,
      );
    }
  }

  if (pagination.type === PaginationType.OFFSET) {
    const page = pagination.page || 1;
    const limit = pagination.limit || 20;
    const windowDepth = (page - 1) * limit + limit;
    if (windowDepth > MAX_RESULT_WINDOW) {
      throw new BadRequestException(
        `Search result window exceeds maximum depth of ${MAX_RESULT_WINDOW}. Please narrow your search query or use cursor-based pagination.`,
      );
    }
  }
}

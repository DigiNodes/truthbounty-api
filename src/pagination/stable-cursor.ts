// src/pagination/stable-cursor.ts
import { Injectable } from '@nestjs/common';

/**
 * Stable Cursor Pagination Implementation
 *
 * Provides deterministic tie-breaking cursors for claims, evidence, verifications,
 * disputes, rewards, and activity feeds.
 *
 * Implements V2-BE-058: Implement Stable Cursor Pagination
 */

export interface StableCursor<T = any> {
  /** Opaque cursor string for pagination */
  cursor: string;
  /** The sort field used for ordering */
  sortField: string;
  /** Sort direction */
  sortDirection: 'ASC' | 'DESC';
  /** Timestamp when cursor was created */
  createdAt: number;
  /** Additional metadata for tie-breaking */
  tieBreaker?: T;
}

export interface PaginationOptions {
  /** Maximum number of items per page */
  limit?: number;
  /** Cursor for next page */
  cursor?: string;
  /** Sort field */
  sortBy?: string;
  /** Sort direction */
  sortOrder?: 'ASC' | 'DESC';
  /** Tie-breaker field (for stable ordering) */
  tieBreakerField?: string;
}

export interface PaginatedResult<T> {
  /** Items in current page */
  items: T[];
  /** Cursor for next page */
  nextCursor?: string;
  /** Whether there are more items */
  hasMore: boolean;
  /** Total count (if available) */
  totalCount?: number;
}

/**
 * Stable cursor encoding/decoding utilities
 */
export class StableCursorUtil {
  private static readonly CURSOR_VERSION = 'v1';
  private static readonly SEPARATOR = '|';

  /**
   * Encode a stable cursor
   */
  static encode(cursor: StableCursor): string {
    const payload = {
      v: this.CURSOR_VERSION,
      sf: cursor.sortField,
      sd: cursor.sortDirection,
      ts: cursor.createdAt,
      tb: cursor.tieBreaker,
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  /**
   * Decode a stable cursor
   */
  static decode(encoded: string): StableCursor | null {
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
      if (payload.v !== this.CURSOR_VERSION) {
        return null; // Version mismatch
      }
      return {
        cursor: encoded,
        sortField: payload.sf,
        sortDirection: payload.sd,
        createdAt: payload.ts,
        tieBreaker: payload.tb,
      };
    } catch {
      return null;
    }
  }

  /**
   * Create a cursor from sort values
   */
  static createFromValues(
    sortField: string,
    sortDirection: 'ASC' | 'DESC',
    sortValue: any,
    tieBreakerValue?: any,
  ): StableCursor {
    return {
      cursor: '', // Will be set by encode
      sortField,
      sortDirection,
      createdAt: Date.now(),
      tieBreaker: tieBreakerValue ?? sortValue,
    };
  }
}

/**
 * Cursor-based pagination for TypeORM QueryBuilder
 */
@Injectable()
export class CursorPaginationService {
  /**
   * Apply cursor-based pagination to a query builder
   */
  applyCursor<T>(
    qb: any,
    cursor: string | undefined,
    options: PaginationOptions,
  ): { hasCursor: boolean; cursorData: StableCursor | null } {
    if (!cursor) {
      return { hasCursor: false, cursorData: null };
    }

    const cursorData = StableCursorUtil.decode(cursor);
    if (!cursorData) {
      return { hasCursor: false, cursorData: null };
    }

    const sortField = options.sortBy || cursorData.sortField;
    const sortDirection = options.sortOrder || cursorData.sortDirection;

    // Apply cursor filter for stable pagination
    const operator = sortDirection === 'ASC' ? '>' : '<';

    // Primary sort filter
    qb.andWhere(`${qb.alias}.${sortField} ${operator} :cursorValue`, {
      cursorValue: cursorData.tieBreaker,
    });

    // Tie-breaker on ID for stable ordering
    if (options.tieBreakerField) {
      qb.andWhere(
        `(${qb.alias}.${sortField} ${operator} :cursorValue OR (${qb.alias}.${sortField} = :cursorValue AND ${qb.alias}.${options.tieBreakerField} > :tieBreakerId))`,
        {
          cursorValue: cursorData.tieBreaker,
          tieBreakerId: cursorData.tieBreaker,
        },
      );
    } else {
      // Default tie-breaker on ID
      qb.andWhere(
        `(${qb.alias}.${sortField} ${operator} :cursorValue OR (${qb.alias}.${sortField} = :cursorValue AND ${qb.alias}.id > :tieBreakerId))`,
        {
          cursorValue: cursorData.tieBreaker,
          tieBreakerId: cursorData.tieBreaker,
        },
      );
    }

    return { hasCursor: true, cursorData };
  }

  /**
   * Build paginated result with next cursor
   */
  buildResult<T>(
    items: any[],
    limit: number,
    sortField: string,
    sortDirection: 'ASC' | 'DESC',
    tieBreakerField: string = 'id',
  ): PaginatedResult<any> {
    const hasMore = items.length > limit;
    const itemsToReturn = hasMore ? items.slice(0, -1) : items;

    let nextCursor: string | undefined;
    if (itemsToReturn.length > 0) {
      const lastItem = itemsToReturn[itemsToReturn.length - 1];
      const cursor = StableCursorUtil.createFromValues(
        sortField,
        sortDirection,
        lastItem[sortField],
        lastItem.id,
      );
      // We need to encode it properly
      const cursorObj = {
        ...cursor,
        cursor: StableCursorUtil.encode({
          ...cursor,
          cursor: '',
        }),
      };
      // Re-encode with the actual cursor string
      const payload = {
        v: 'v1',
        sf: sortField,
        sd: sortDirection,
        ts: Date.now(),
        tb: lastItem.id,
      };
      const nextCursor = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return {
        items: itemsToReturn,
        nextCursor,
        hasMore: true,
      };
    }

    return {
      items: itemsToReturn,
      nextCursor: undefined,
      hasMore: false,
    };
  }
}

/**
 * Pagination helper for array-based data
 */
export function paginateArray<T>(
  items: T[],
  options: PaginationOptions,
): PaginatedResult<T> {
  const limit = options.limit || 20;
  const sortBy = options.sortBy || 'id';
  const sortOrder = options.sortOrder || 'DESC';
  const tieBreakerField = options.tieBreakerField || 'id';

  // Sort items
  const sortedItems = [...items].sort((a, b) => {
    const aVal = (a as any)[options.sortBy || 'id'];
    const bVal = (b as any)[options.sortBy || 'id'];
    const direction = options.sortOrder === 'ASC' ? 1 : -1;
    if (aVal < bVal) return -1 * (options.sortOrder === 'ASC' ? 1 : -1);
    if (aVal > bVal) return 1 * (options.sortOrder === 'ASC' ? 1 : -1);
    return 0;
  });

  // Apply cursor if provided
  let startIndex = 0;
  if (options.cursor) {
    const cursorData = StableCursorUtil.decode(options.cursor);
    if (cursorData) {
      const cursorIndex = items.findIndex(
        (item) => (item as any).id === cursorData.tieBreaker,
      );
      if (cursorIndex >= 0) {
        startIndex = cursorIndex + 1;
      }
    }
  }

  const pageItems = items.slice(startIndex, startIndex + limit + 1);
  const hasMore = pageItems.length > limit;
  const page = hasMore ? pageItems.slice(0, -1) : pageItems;

  let nextCursor: string | undefined;
  if (page.length > 0) {
    const lastItem = page[page.length - 1];
    const cursor = StableCursorUtil.encode({
      cursor: '',
      sortField: options.sortBy || 'id',
      sortDirection: options.sortOrder || 'DESC',
      createdAt: Date.now(),
      tieBreaker: (page[page.length - 1] as any).id,
    });
    nextCursor = StableCursorUtil.encode({
      cursor: '',
      sortField: options.sortBy || 'id',
      sortDirection: options.sortOrder || 'DESC',
      createdAt: Date.now(),
      tieBreaker: (page[page.length - 1] as any).id,
    });
  }

  return {
    items: page,
    nextCursor,
    hasMore: pageItems.length > limit,
  };
}
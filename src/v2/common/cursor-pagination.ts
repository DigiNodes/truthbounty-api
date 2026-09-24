import { BadRequestException } from '@nestjs/common';

/**
 * Deterministic keyset pagination for V2 event-derived read models.
 *
 * All V2 projections are ordered by chain-native coordinates
 * (blockNumber, logIndex) with the row id as a final tiebreaker, never by
 * offset/page number. Offset pagination silently skips or duplicates rows
 * when new events land between requests; a keyset cursor over immutable
 * ordering coordinates does not.
 */
export interface OrderKey {
  blockNumber: string;
  logIndex: number;
  id: string;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** Encode an order key into an opaque, URL-safe cursor string. */
export function encodeCursor(key: OrderKey): string {
  // blockNumber may arrive as a JS number under sqlite (used only in tests)
  // even though the column is declared bigint; normalize to string so the
  // cursor format is stable regardless of the underlying driver.
  const raw = JSON.stringify([String(key.blockNumber), key.logIndex, key.id]);
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Decode a cursor string produced by {@link encodeCursor}. Throws on tampering. */
export function decodeCursor(cursor: string): OrderKey {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [blockNumber, logIndex, id] = JSON.parse(raw) as [
      string,
      number,
      string,
    ];
    if (
      typeof blockNumber !== 'string' ||
      typeof logIndex !== 'number' ||
      typeof id !== 'string'
    ) {
      throw new Error('malformed cursor payload');
    }
    return { blockNumber, logIndex, id };
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export function clampPageSize(requested?: number): number {
  if (!requested || Number.isNaN(requested) || requested <= 0)
    return DEFAULT_PAGE_SIZE;
  return Math.min(requested, MAX_PAGE_SIZE);
}

/**
 * Turn a "limit + 1" keyset fetch into a stable page.
 *
 * Queries MUST fetch one extra row beyond the page size so presence of a
 * surplus row unambiguously signals "another page exists". Without the probe
 * row the last real row is indistinguishable from a page boundary, which is
 * what caused page-size-exact queries to emit a nextCursor pointing at the
 * last item (or omit it) depending on boundary rounding. ID tiebreaking in
 * ORDER BY + cursor predicate guarantees a stable total order even when two
 * rows share the same (blockNumber, logIndex).
 */
export function pageResult<T>(
  rows: T[],
  pageSize: number,
  keyOf: (row: T) => { blockNumber: string | number; logIndex: number; id: string },
): CursorPage<T> {
  const hasMore = rows.length > pageSize;
  const items = hasMore ? rows.slice(0, pageSize) : rows;
  const last = items[items.length - 1];

  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({
            blockNumber: String(keyOf(last).blockNumber),
            logIndex: keyOf(last).logIndex,
            id: keyOf(last).id,
          })
        : null,
  };
}

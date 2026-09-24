import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  OrderKey,
  clampPageSize,
  decodeCursor,
  encodeCursor,
  pageResult,
} from './cursor-pagination';

describe('cursor-pagination', () => {
  describe('encodeCursor / decodeCursor', () => {
    it('round-trips an order key', () => {
      const key: OrderKey = {
        blockNumber: '12345',
        logIndex: 7,
        id: 'evt-001',
      };
      expect(decodeCursor(encodeCursor(key))).toEqual(key);
    });

    it('produces URL-safe, stable cursors for the same key', () => {
      const a = encodeCursor({ blockNumber: '100', logIndex: 9, id: 'y' });
      const b = encodeCursor({ blockNumber: '100', logIndex: 9, id: 'y' });
      expect(a).toBe(b);
      expect(a).not.toMatch(/[+/=]/);
    });

    it('rejects a tampered cursor', () => {
      expect(() => decodeCursor('not-a-cursor')).toThrow(BadRequestException);
      expect(() => decodeCursor(Buffer.from('{}').toString('base64url'))).toThrow(
        BadRequestException,
      );
      expect(() =>
        decodeCursor(Buffer.from('[1,2]').toString('base64url')),
      ).toThrow(BadRequestException);
    });
  });

  describe('clampPageSize', () => {
    it('applies the default when absent, invalid, or non-positive', () => {
      expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
      expect(clampPageSize(NaN)).toBe(DEFAULT_PAGE_SIZE);
      expect(clampPageSize(0)).toBe(DEFAULT_PAGE_SIZE);
      expect(clampPageSize(-5)).toBe(DEFAULT_PAGE_SIZE);
    });

    it('clamps oversized requests to the maximum page size', () => {
      expect(clampPageSize(1000)).toBe(MAX_PAGE_SIZE);
      expect(clampPageSize(MAX_PAGE_SIZE)).toBe(MAX_PAGE_SIZE);
    });

    it('keeps in-range requests as-is', () => {
      expect(clampPageSize(5)).toBe(5);
    });
  });

  describe('pageResult', () => {
    const keyOf = (row: { block: number; idx: number; id: string }) => ({
      blockNumber: row.block,
      logIndex: row.idx,
      id: row.id,
    });

    it('returns no nextCursor when there is no surplus row (final page)', () => {
      const rows = [
        { block: 1, idx: 0, id: 'a' },
        { block: 2, idx: 0, id: 'b' },
      ];
      const { items, nextCursor } = pageResult(rows, 2, keyOf);
      expect(items).toHaveLength(2);
      expect(nextCursor).toBeNull();
    });

    it('exposes a nextCursor over the last returned row when a surplus row exists', () => {
      const rows = [
        { block: 1, idx: 0, id: 'a' },
        { block: 2, idx: 4, id: 'b' },
        { block: 3, idx: 0, id: 'c' },
      ];
      const { items, nextCursor } = pageResult(rows, 2, keyOf);
      expect(items.map((r) => r.id)).toEqual(['a', 'b']);
      expect(nextCursor).not.toBeNull();
      expect(decodeCursor(nextCursor as string)).toEqual({
        blockNumber: '2',
        logIndex: 4,
        id: 'b',
      });
    });

    it('trims to the page size and never exposes the probe row', () => {
      const rows = Array.from({ length: 26 }, (_, i) => ({
        block: i,
        idx: 0,
        id: `r-${i}`,
      }));
      const { items, nextCursor } = pageResult(rows, 25, keyOf);
      expect(items).toHaveLength(25);
      expect(items.some((r) => r.id === 'r-25')).toBe(false);
      expect(nextCursor).not.toBeNull();
    });

    it('returns an empty page and null cursor for no rows', () => {
      const { items, nextCursor } = pageResult([], 10, keyOf);
      expect(items).toEqual([]);
      expect(nextCursor).toBeNull();
    });
  });
});
import { BadRequestException } from '@nestjs/common';
import {
  assertResolvedAtInvariant,
  buildResolvedFields,
  buildUnresolvedFields,
} from './claim-resolution.invariant';

/**
 * Unit tests for the resolvedAt/resolvedVerdict invariant (issue #BE-219).
 *
 * Invariant: resolvedVerdict IS NOT NULL  <=>  resolvedAt IS NOT NULL
 */
describe('claim-resolution invariant (BE-219)', () => {
  // ------------------------------------------------------------------ //
  // assertResolvedAtInvariant                                            //
  // ------------------------------------------------------------------ //
  describe('assertResolvedAtInvariant', () => {
    it('passes when both fields are null (unresolved claim)', () => {
      expect(() =>
        assertResolvedAtInvariant({ resolvedVerdict: null, resolvedAt: null }),
      ).not.toThrow();
    });

    it('passes when both fields are set (resolved claim)', () => {
      expect(() =>
        assertResolvedAtInvariant({
          resolvedVerdict: true,
          resolvedAt: new Date(),
        }),
      ).not.toThrow();

      expect(() =>
        assertResolvedAtInvariant({
          resolvedVerdict: false,
          resolvedAt: new Date(),
        }),
      ).not.toThrow();
    });

    it('throws when resolvedVerdict is set but resolvedAt is null (bug scenario)', () => {
      expect(() =>
        assertResolvedAtInvariant({ resolvedVerdict: true, resolvedAt: null }),
      ).toThrow(BadRequestException);

      expect(() =>
        assertResolvedAtInvariant({ resolvedVerdict: false, resolvedAt: null }),
      ).toThrow(BadRequestException);
    });

    it('includes BE-219 in the error message for the verdict-without-timestamp case', () => {
      expect(() =>
        assertResolvedAtInvariant({ resolvedVerdict: true, resolvedAt: null }),
      ).toThrow(/BE-219/);
    });

    it('throws when resolvedAt is set but resolvedVerdict is null (inverse bug)', () => {
      expect(() =>
        assertResolvedAtInvariant({ resolvedVerdict: null, resolvedAt: new Date() }),
      ).toThrow(BadRequestException);
    });

    it('includes BE-219 in the error message for the timestamp-without-verdict case', () => {
      expect(() =>
        assertResolvedAtInvariant({ resolvedVerdict: null, resolvedAt: new Date() }),
      ).toThrow(/BE-219/);
    });
  });

  // ------------------------------------------------------------------ //
  // buildResolvedFields                                                   //
  // ------------------------------------------------------------------ //
  describe('buildResolvedFields', () => {
    it('returns verdict=true and a non-null Date', () => {
      const fields = buildResolvedFields(true);
      expect(fields.resolvedVerdict).toBe(true);
      expect(fields.resolvedAt).toBeInstanceOf(Date);
      expect(fields.resolvedAt).not.toBeNull();
    });

    it('returns verdict=false and a non-null Date', () => {
      const fields = buildResolvedFields(false);
      expect(fields.resolvedVerdict).toBe(false);
      expect(fields.resolvedAt).toBeInstanceOf(Date);
    });

    it('uses the provided date when supplied', () => {
      const fixedDate = new Date('2026-01-01T12:00:00Z');
      const fields = buildResolvedFields(true, fixedDate);
      expect(fields.resolvedAt).toBe(fixedDate);
    });

    it('always passes assertResolvedAtInvariant', () => {
      const fields = buildResolvedFields(true);
      expect(() => assertResolvedAtInvariant(fields)).not.toThrow();
    });

    it('result fields are never undefined', () => {
      const fields = buildResolvedFields(false);
      expect(fields.resolvedVerdict).not.toBeUndefined();
      expect(fields.resolvedAt).not.toBeUndefined();
    });
  });

  // ------------------------------------------------------------------ //
  // buildUnresolvedFields                                                 //
  // ------------------------------------------------------------------ //
  describe('buildUnresolvedFields', () => {
    it('returns both fields as null', () => {
      const fields = buildUnresolvedFields();
      expect(fields.resolvedVerdict).toBeNull();
      expect(fields.resolvedAt).toBeNull();
    });

    it('always passes assertResolvedAtInvariant', () => {
      const fields = buildUnresolvedFields();
      expect(() => assertResolvedAtInvariant(fields)).not.toThrow();
    });
  });
});

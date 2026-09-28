import {
  AUTH_GENERIC_FAILURE_MESSAGE,
  constantTimeAddressEqual,
  timingSafeEqualBytes,
  timingSafeEqualHex,
  timingSafeEqualUtf8,
} from './timing-safe.util';
import { timingSafeEqual } from 'crypto';

describe('timing-safe.util (issue-416)', () => {
  describe('timingSafeEqualUtf8', () => {
    it('returns true for equal strings', () => {
      expect(timingSafeEqualUtf8('abc', 'abc')).toBe(true);
    });

    it('returns false for different strings of equal length', () => {
      expect(timingSafeEqualUtf8('abc', 'abd')).toBe(false);
    });

    it('returns false for length mismatch without throwing', () => {
      expect(() => timingSafeEqualUtf8('short', 'much-longer-value')).not.toThrow();
      expect(timingSafeEqualUtf8('short', 'much-longer-value')).toBe(false);
    });
  });

  describe('timingSafeEqualHex', () => {
    it('compares sha256 hex digests in constant time', () => {
      const a = 'ab'.repeat(32);
      const b = 'ab'.repeat(32);
      expect(timingSafeEqualHex(a, b)).toBe(true);
      expect(timingSafeEqualHex(a, `${'ab'.repeat(31)}ac`)).toBe(false);
    });

    it('returns false on length mismatch without throwing', () => {
      expect(() => timingSafeEqualHex('ab', 'abcd')).not.toThrow();
      expect(timingSafeEqualHex('ab', 'abcd')).toBe(false);
    });

    it('does not throw for non-hex input', () => {
      expect(() => timingSafeEqualHex('!!!', '???')).not.toThrow();
      expect(timingSafeEqualHex('!!!', '???')).toBe(false);
    });
  });

  describe('timingSafeEqualBytes', () => {
    it('never throws on length mismatch (unlike crypto.timingSafeEqual)', () => {
      expect(() => timingSafeEqual(Buffer.from('a'), Buffer.from('ab'))).toThrow();
      expect(() => timingSafeEqualBytes(Buffer.from('a'), Buffer.from('ab'))).not.toThrow();
      expect(timingSafeEqualBytes(Buffer.from('a'), Buffer.from('ab'))).toBe(false);
    });
  });

  describe('constantTimeAddressEqual', () => {
    it('compares addresses case-insensitively', () => {
      expect(
        constantTimeAddressEqual(
          '0xAbC123',
          '0xabc123',
        ),
      ).toBe(true);
    });

    it('returns false on mismatch without leaking via early return', () => {
      expect(constantTimeAddressEqual('0xabc1', '0xabc2')).toBe(false);
      expect(constantTimeAddressEqual('0xabc', '0xabcdef123')).toBe(false);
    });
  });

  describe('constant-shape contract', () => {
    it('exposes a single generic failure message', () => {
      expect(AUTH_GENERIC_FAILURE_MESSAGE).toBe('Invalid credentials');
    });
  });
});

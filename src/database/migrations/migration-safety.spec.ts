import {
  assertForwardBackwardSafe,
  assertStrictlyIncreasing,
  parseMigrationId,
} from './migration-safety';

describe('migration safety (issue #464)', () => {
  it('parses migration ids', () => {
    const meta = parseMigrationId('1769500000000-OptimizeClaimIndexes');
    expect(meta.timestamp).toBe(1769500000000);
    expect(meta.name).toBe('OptimizeClaimIndexes');
  });

  it('requires increasing timestamps', () => {
    expect(() =>
      assertStrictlyIncreasing(['2-b', '1-a']),
    ).toThrow(/MIGRATION_ORDER_VIOLATION/);
  });

  it('round-trips forward and backward order', () => {
    const ids = ['1-a', '2-b', '3-c'];
    expect(assertForwardBackwardSafe(ids)).toEqual(ids);
  });
});

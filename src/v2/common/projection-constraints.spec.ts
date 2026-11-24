import {
  deriveDisputeId,
  isDisputeTerminal,
  isDisputeTransitionAllowed,
  isRoundTerminal,
  isRoundTransitionAllowed,
  isUniqueViolation,
  redactEventCoordinate,
} from './projection-constraints';

describe('projection-constraints (issue396 unit)', () => {
  it('derives deterministic canonical dispute ids', () => {
    expect(deriveDisputeId('0xclaim', '0xround')).toBe('0xclaim:0xround');
    expect(deriveDisputeId('a', 'b')).toContain(':');
  });

  it('allows only RAISED -> RESOLVED|EXPIRED dispute transitions', () => {
    expect(isDisputeTransitionAllowed('raised', 'resolved')).toBe(true);
    expect(isDisputeTransitionAllowed('raised', 'expired')).toBe(true);
    expect(isDisputeTransitionAllowed('raised', 'raised')).toBe(true);
    expect(isDisputeTransitionAllowed('resolved', 'expired')).toBe(false);
    expect(isDisputeTransitionAllowed('expired', 'raised')).toBe(false);
    expect(isDisputeTransitionAllowed('resolved', 'resolved')).toBe(true);
  });

  it('marks dispute terminal states as immutable-final', () => {
    expect(isDisputeTerminal('resolved')).toBe(true);
    expect(isDisputeTerminal('expired')).toBe(true);
    expect(isDisputeTerminal('raised')).toBe(false);
  });

  it('allows only OPEN -> CLOSED|RESOLVED round transitions', () => {
    expect(isRoundTransitionAllowed('open', 'closed')).toBe(true);
    expect(isRoundTransitionAllowed('open', 'resolved')).toBe(true);
    expect(isRoundTransitionAllowed('closed', 'open')).toBe(false);
    expect(isRoundTransitionAllowed('resolved', 'open')).toBe(false);
    expect(isRoundTerminal('closed')).toBe(true);
    expect(isRoundTerminal('resolved')).toBe(true);
    expect(isRoundTerminal('open')).toBe(false);
  });

  it('redacts event coordinates without leaking payloads', () => {
    const redacted = redactEventCoordinate(`0x${'ab'.repeat(32)}`, 7);
    expect(redacted).toContain(':7');
    expect(redacted.length).toBeLessThan(20);
    expect(redacted).not.toContain('ab'.repeat(32));
  });

  it('treats Postgres and SQLite unique violations as idempotent replay', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT' })).toBe(true);
    expect(isUniqueViolation({ code: 'OTHER' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

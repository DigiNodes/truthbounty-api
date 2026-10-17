import { ClaimState, parseClaimState } from '../../../domain/claim/claimState';
import {
  CLAIM_STATE_TO_STATUS,
  STATUS_TO_CLAIM_STATES,
  ProjectionStatus,
  parseProjectionStatus,
} from '../projection-claim-state-map';

describe('Canonical ClaimState', () => {
  const ALL_CANONICAL: ClaimState[] = [
    ClaimState.Submitted,
    ClaimState.Review,
    ClaimState.Verified,
    ClaimState.Rejected,
    ClaimState.Disputed,
    ClaimState.Finalized,
    ClaimState.Reorged,
  ];

  it('has exactly 7 canonical states', () => {
    expect(Object.values(ClaimState)).toHaveLength(7);
    expect(ALL_CANONICAL).toHaveLength(7);
  });

  it('maps every canonical state to exactly one projection status', () => {
    for (const state of ALL_CANONICAL) {
      const status = CLAIM_STATE_TO_STATUS[state];
      expect(status).toBeDefined();
      expect(typeof status).toBe('string');
    }
  });

  it('reverses the mapping without loss — every state is reachable from its bucket', () => {
    for (const state of ALL_CANONICAL) {
      const status = CLAIM_STATE_TO_STATUS[state];
      expect(STATUS_TO_CLAIM_STATES[status]).toContain(state);
    }
  });

  it('every status bucket contains at least one state', () => {
    for (const status of Object.keys(STATUS_TO_CLAIM_STATES) as ProjectionStatus[]) {
      expect(STATUS_TO_CLAIM_STATES[status].length).toBeGreaterThan(0);
    }
  });

  it.each([
    [ClaimState.Submitted, 'SUBMITTED'],
    [ClaimState.Review, 'REVIEW'],
    [ClaimState.Verified, 'VERIFIED'],
    [ClaimState.Rejected, 'REJECTED'],
    [ClaimState.Disputed, 'DISPUTED'],
    [ClaimState.Finalized, 'FINALIZED'],
    [ClaimState.Reorged, 'REORGED'],
  ])('maps %s to stable serialization %s', (state, raw) => {
    expect(state).toBe(raw);
  });

  // Required tests from #614:
  describe('parseClaimState — fail closed', () => {
    it.each([
      ['SUBMITTED', ClaimState.Submitted],
      ['REVIEW', ClaimState.Review],
      ['VERIFIED', ClaimState.Verified],
      ['REJECTED', ClaimState.Rejected],
      ['DISPUTED', ClaimState.Disputed],
      ['FINALIZED', ClaimState.Finalized],
      ['REORGED', ClaimState.Reorged],
    ])('parses %s', (raw, expected) => {
      expect(parseClaimState(raw)).toBe(expected);
    });

    it('throws on unknown state (no coercion)', () => {
      expect(() => parseClaimState('UNDER_VERIFICATION')).toThrow(
        /Unknown claim state/,
      );
      expect(() => parseClaimState('')).toThrow(/Unknown claim state/);
      expect(() => parseClaimState(null)).toThrow(/Unknown claim state/);
      expect(() => parseClaimState(42)).toThrow(/Unknown claim state/);
      expect(() => parseClaimState({})).toThrow(/Unknown claim state/);
    });
  });
});

describe('Projection status mapping', () => {
  it.each<[string, ProjectionStatus]>([
    ['open', 'open'],
    ['in_review', 'in_review'],
    ['verified', 'verified'],
    ['rejected', 'rejected'],
    ['disputed', 'disputed'],
    ['finalized', 'finalized'],
    ['reorged', 'reorged'],
  ])('parses projection status %s', (raw, expected) => {
    expect(parseProjectionStatus(raw)).toBe(expected);
  });

  it('throws on unknown status instead of returning all states', () => {
    expect(() => parseProjectionStatus('unknown')).toThrow(
      /Unknown projection status/,
    );
    expect(() => parseProjectionStatus(undefined)).toThrow(
      /Unknown projection status/,
    );
  });

  it('serializes status → states deterministically (same array each call)', () => {
    for (const status of Object.keys(STATUS_TO_CLAIM_STATES) as ProjectionStatus[]) {
      const a = STATUS_TO_CLAIM_STATES[status];
      const b = STATUS_TO_CLAIM_STATES[status];
      expect(a).toBe(b);
    }
  });
});

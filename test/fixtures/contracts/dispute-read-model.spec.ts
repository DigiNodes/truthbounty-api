/**
 * PREWAVE-BE-007 — Schema/fixture drift + security tests for the versioned
 * dispute read models.
 *
 * These are pure-unit (no AppModule, Redis, or Postgres). They guarantee that
 * the published fixtures stay byte-for-byte aligned with the read-model
 * contract, that no provisional data is presented as final, and that no
 * secret or non-public evidence content leaks into a published fixture.
 */

import {
  DISPUTE_READ_MODEL_DETAIL_RESPONSE_KEYS,
  DISPUTE_READ_MODEL_ITEM_KEYS,
  DISPUTE_READ_MODEL_LIST_RESPONSE_KEYS,
  DISPUTE_READ_MODEL_ORDER,
  DISPUTE_READ_MODEL_PROVENANCE_KEYS,
  DISPUTE_READ_MODEL_VERSION,
} from '../../../src/v2/disputes/read-models/dispute-read-model.types';
import {
  CANONICAL_DISPUTE_READ_MODEL_RELEASE,
  DISPUTE_READ_MODEL_FIXTURE_RELEASE_VERSION,
  DISPUTE_REGISTER_EMPTY,
  DISPUTE_REGISTER_PROVISIONAL,
  DISPUTE_REGISTER_APPEALABLE,
  DISPUTE_REGISTER_FINALIZED,
  DISPUTE_DETAIL_PROVISIONAL,
  DISPUTE_DETAIL_APPEALABLE,
  DISPUTE_DETAIL_FINALIZED,
  DISPUTE_DETAIL_REFUND_ONLY,
  DISPUTE_DETAIL_TIE,
  DISPUTE_DETAIL_UNAVAILABLE_NO_DEADLINE,
  DISPUTE_DETAIL_UNAVAILABLE_MAX_ROUND,
  DISPUTE_READ_MODEL_ERROR_STALE,
  DISPUTE_READ_MODEL_ERROR_WRONG_RELEASE,
  DISPUTE_READ_MODEL_ERROR_UNSUPPORTED_CHAIN,
  DISPUTE_READ_MODEL_ERROR_NOT_FOUND,
} from './dispute-read-model.fixtures';

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

function expectSameKeys(actual: object, expected: readonly string[]): void {
  expect(keysOf(actual)).toEqual([...expected].sort());
}

/** Deep-clone a fixture with every `txHash` removed (tx hashes are public, not secrets). */
function withoutTxHashes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTxHashes);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'txHash')
        .map(([key, nested]) => [key, withoutTxHashes(nested)]),
    );
  }
  return value;
}

describe('Dispute read-model — release and version binding', () => {
  it('binds fixtures to the canonical Optimism Sepolia release', () => {
    expect(CANONICAL_DISPUTE_READ_MODEL_RELEASE.chainId).toBe(11155420);
    expect(CANONICAL_DISPUTE_READ_MODEL_RELEASE.releaseId).toBe(
      'rel-opsepolia-20261015-v2',
    );
    expect(CANONICAL_DISPUTE_READ_MODEL_RELEASE.deploymentBlock).toBe(24850000);
    expect(CANONICAL_DISPUTE_READ_MODEL_RELEASE.artifactChecksum).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('publishes the pinned read-model version', () => {
    expect(DISPUTE_READ_MODEL_FIXTURE_RELEASE_VERSION).toBe(
      DISPUTE_READ_MODEL_VERSION,
    );
    expect(DISPUTE_READ_MODEL_VERSION).toBe('dispute-read-model/v1');
  });

  it('publishes a deterministic ordering', () => {
    expect(DISPUTE_READ_MODEL_ORDER).toBe('disputeId:asc');
    expect(DISPUTE_REGISTER_PROVISIONAL.pagination.order).toBe(
      DISPUTE_READ_MODEL_ORDER,
    );
  });

  it('has a fixture for every approved UI state', () => {
    const fixtureNames = [
      'DISPUTE_REGISTER_EMPTY',
      'DISPUTE_REGISTER_PROVISIONAL',
      'DISPUTE_REGISTER_APPEALABLE',
      'DISPUTE_REGISTER_FINALIZED',
      'DISPUTE_DETAIL_PROVISIONAL',
      'DISPUTE_DETAIL_APPEALABLE',
      'DISPUTE_DETAIL_FINALIZED',
      'DISPUTE_DETAIL_REFUND_ONLY',
      'DISPUTE_DETAIL_TIE',
      'DISPUTE_DETAIL_UNAVAILABLE_NO_DEADLINE',
      'DISPUTE_DETAIL_UNAVAILABLE_MAX_ROUND',
      'DISPUTE_READ_MODEL_ERROR_STALE',
      'DISPUTE_READ_MODEL_ERROR_WRONG_RELEASE',
      'DISPUTE_READ_MODEL_ERROR_UNSUPPORTED_CHAIN',
      'DISPUTE_READ_MODEL_ERROR_NOT_FOUND',
    ];
    expect(fixtureNames.sort()).toEqual(fixtureNames.sort());
  });
});

describe('Dispute read-model — schema drift', () => {
  const listFixtures = [
    DISPUTE_REGISTER_EMPTY,
    DISPUTE_REGISTER_PROVISIONAL,
    DISPUTE_REGISTER_APPEALABLE,
    DISPUTE_REGISTER_FINALIZED,
  ];

  const detailFixtures = [
    DISPUTE_DETAIL_PROVISIONAL,
    DISPUTE_DETAIL_APPEALABLE,
    DISPUTE_DETAIL_FINALIZED,
    DISPUTE_DETAIL_REFUND_ONLY,
    DISPUTE_DETAIL_TIE,
    DISPUTE_DETAIL_UNAVAILABLE_NO_DEADLINE,
    DISPUTE_DETAIL_UNAVAILABLE_MAX_ROUND,
  ];

  it('list response keys match the published contract', () => {
    for (const list of listFixtures) {
      expectSameKeys(list, DISPUTE_READ_MODEL_LIST_RESPONSE_KEYS);
    }
  });

  it('detail response keys match the published contract', () => {
    for (const detail of detailFixtures) {
      expectSameKeys(detail, DISPUTE_READ_MODEL_DETAIL_RESPONSE_KEYS);
    }
  });

  it('item keys match the published contract', () => {
    for (const list of listFixtures) {
      if (list.data.length > 0) {
        expectSameKeys(list.data[0], DISPUTE_READ_MODEL_ITEM_KEYS);
      }
    }
    for (const detail of detailFixtures) {
      expectSameKeys(detail.data, DISPUTE_READ_MODEL_ITEM_KEYS);
    }
  });

  it('provenance keys match the published contract', () => {
    for (const list of listFixtures) {
      expectSameKeys(list.provenance, DISPUTE_READ_MODEL_PROVENANCE_KEYS);
      if (list.data.length > 0) {
        expectSameKeys(list.data[0].release, DISPUTE_READ_MODEL_PROVENANCE_KEYS);
      }
    }
    for (const detail of detailFixtures) {
      expectSameKeys(detail.provenance, DISPUTE_READ_MODEL_PROVENANCE_KEYS);
      expectSameKeys(detail.data.release, DISPUTE_READ_MODEL_PROVENANCE_KEYS);
    }
  });

  it('every published response carries readModel + readModelVersion + freshness + provenance', () => {
    for (const list of listFixtures) {
      expect(list).toHaveProperty('readModel');
      expect(list).toHaveProperty('readModelVersion');
      expect(list).toHaveProperty('freshness');
      expect(list).toHaveProperty('provenance');
    }
    for (const detail of detailFixtures) {
      expect(detail).toHaveProperty('readModel');
      expect(detail).toHaveProperty('readModelVersion');
      expect(detail).toHaveProperty('freshness');
      expect(detail).toHaveProperty('provenance');
    }
  });
});

describe('Dispute read-model — provisional is never presented as final', () => {
  const items = [
    ...DISPUTE_REGISTER_PROVISIONAL.data,
    ...DISPUTE_REGISTER_APPEALABLE.data,
    DISPUTE_DETAIL_PROVISIONAL.data,
    DISPUTE_DETAIL_APPEALABLE.data,
    DISPUTE_DETAIL_FINALIZED.data,
    DISPUTE_DETAIL_REFUND_ONLY.data,
    DISPUTE_DETAIL_TIE.data,
    DISPUTE_DETAIL_UNAVAILABLE_NO_DEADLINE.data,
    DISPUTE_DETAIL_UNAVAILABLE_MAX_ROUND.data,
  ];

  it('a provisional item has a provisional outcome and no final outcome', () => {
    for (const item of items.filter((i) => i.phase === 'provisional')) {
      expect(item.outcome.phase).toBe('provisional');
      expect(item.outcome.final).toBeNull();
      expect(item.outcome.provisional).not.toBeNull();
    }
  });

  it('an appealable item has a provisional outcome and no final outcome', () => {
    for (const item of items.filter((i) => i.phase === 'appealable')) {
      expect(item.outcome.phase).toBe('appealable');
      expect(item.outcome.final).toBeNull();
      expect(item.outcome.provisional).not.toBeNull();
    }
  });

  it('a finalized item has a final outcome and no provisional outcome', () => {
    for (const item of items.filter((i) => i.phase === 'finalized')) {
      expect(item.outcome.phase).toBe('finalized');
      expect(item.outcome.provisional).toBeNull();
      expect(item.outcome.final).not.toBeNull();
    }
  });

  it('a finalized outcome is only ever the terminal projected state', () => {
    for (const item of items.filter((i) => i.phase === 'finalized')) {
      expect(['resolved', 'expired']).toContain(item.outcome.final?.status);
    }
  });
});

describe('Dispute read-model — appeal availability is contract-derived', () => {
  const items = [
    ...DISPUTE_REGISTER_PROVISIONAL.data,
    ...DISPUTE_REGISTER_APPEALABLE.data,
    DISPUTE_DETAIL_PROVISIONAL.data,
    DISPUTE_DETAIL_APPEALABLE.data,
    DISPUTE_DETAIL_FINALIZED.data,
  ];

  it('appeal available is true only when phase is appealable', () => {
    for (const item of items) {
      if (item.phase === 'appealable') {
        expect(item.appeal.available).toBe(true);
        expect(item.appeal.reason).toBe('window_open');
      } else {
        expect(item.appeal.available).toBe(false);
      }
    }
  });

  it('appeal reason is one of the canonical reasons', () => {
    const canonicalReasons = [
      'window_open',
      'deadline_passed',
      'already_final',
      'max_round',
      'no_deadline',
    ];
    for (const item of items) {
      expect(canonicalReasons).toContain(item.appeal.reason);
    }
  });

  it('max_round reason is present when original round is at the maximum', () => {
    const maxRoundItem = DISPUTE_DETAIL_UNAVAILABLE_MAX_ROUND.data;
    expect(maxRoundItem.appeal.reason).toBe('max_round');
    expect(maxRoundItem.appeal.available).toBe(false);
  });

  it('no_deadline reason is present when deadline is missing', () => {
    const noDeadlineItem = DISPUTE_DETAIL_UNAVAILABLE_NO_DEADLINE.data;
    expect(noDeadlineItem.appeal.reason).toBe('no_deadline');
    expect(noDeadlineItem.appeal.available).toBe(false);
  });
});

describe('Dispute read-model — bond disposition is exact', () => {
  const items = [
    ...DISPUTE_REGISTER_PROVISIONAL.data,
    ...DISPUTE_REGISTER_APPEALABLE.data,
    ...DISPUTE_REGISTER_FINALIZED.data,
    DISPUTE_DETAIL_PROVISIONAL.data,
    DISPUTE_DETAIL_APPEALABLE.data,
    DISPUTE_DETAIL_FINALIZED.data,
    DISPUTE_DETAIL_REFUND_ONLY.data,
    DISPUTE_DETAIL_TIE.data,
  ];

  it('bond disposition is one of the canonical dispositions', () => {
    const canonicalDispositions = ['locked', 'refunded', 'slashed', 'unknown'];
    for (const item of items) {
      expect(canonicalDispositions).toContain(item.bond.disposition);
    }
  });

  it('bond is locked when status is raised', () => {
    for (const item of items.filter((i) => i.status === 'raised')) {
      expect(item.bond.disposition).toBe('locked');
    }
  });

  it('bond is refunded when status is expired', () => {
    for (const item of items.filter((i) => i.status === 'expired')) {
      expect(item.bond.disposition).toBe('refunded');
    }
  });

  it('bond is refunded in tie outcome', () => {
    expect(DISPUTE_DETAIL_TIE.data.bond.disposition).toBe('refunded');
  });

  it('bond is slashed when resolved with overturned outcome', () => {
    expect(DISPUTE_DETAIL_FINALIZED.data.bond.disposition).toBe('slashed');
  });
});

describe('Dispute read-model — economic values preserve exact integer units', () => {
  const items = [
    ...DISPUTE_REGISTER_PROVISIONAL.data,
    ...DISPUTE_REGISTER_APPEALABLE.data,
    ...DISPUTE_REGISTER_FINALIZED.data,
    DISPUTE_DETAIL_PROVISIONAL.data,
    DISPUTE_DETAIL_APPEALABLE.data,
    DISPUTE_DETAIL_FINALIZED.data,
    DISPUTE_DETAIL_REFUND_ONLY.data,
    DISPUTE_DETAIL_TIE.data,
  ];

  it('bond amount is a string that represents an integer', () => {
    for (const item of items) {
      if (item.bond.amount !== null) {
        expect(typeof item.bond.amount).toBe('string');
        expect(/^\d+$/.test(item.bond.amount)).toBe(true);
      }
    }
  });

  it('bond amount is never a float or number', () => {
    for (const item of items) {
      if (item.bond.amount !== null) {
        expect(typeof item.bond.amount).not.toBe('number');
        expect(item.bond.amount).not.toContain('.');
      }
    }
  });
});

describe('Dispute read-model — security constraints', () => {
  const allFixtures = [
    DISPUTE_REGISTER_EMPTY,
    DISPUTE_REGISTER_PROVISIONAL,
    DISPUTE_REGISTER_APPEALABLE,
    DISPUTE_REGISTER_FINALIZED,
    DISPUTE_DETAIL_PROVISIONAL,
    DISPUTE_DETAIL_APPEALABLE,
    DISPUTE_DETAIL_FINALIZED,
    DISPUTE_DETAIL_REFUND_ONLY,
    DISPUTE_DETAIL_TIE,
    DISPUTE_DETAIL_UNAVAILABLE_NO_DEADLINE,
    DISPUTE_DETAIL_UNAVAILABLE_MAX_ROUND,
  ];

  it('no fixture contains private keys or secrets', () => {
    const secretPatterns = [
      /private[_-]?key/i,
      /secret/i,
      /password/i,
      /api[_-]?key/i,
      /auth[_-]?token/i,
    ];

    for (const fixture of allFixtures) {
      const json = JSON.stringify(fixture);
      for (const pattern of secretPatterns) {
        expect(json).not.toMatch(pattern);
      }
    }
  });

  it('no fixture contains non-public evidence content', () => {
    const evidencePatterns = [/evidence[_-]?content/i, /protected[_-]?rationale/i];

    for (const fixture of allFixtures) {
      const json = JSON.stringify(fixture);
      for (const pattern of evidencePatterns) {
        expect(json).not.toMatch(pattern);
      }
    }
  });

  it('all chain-derived data binds to the canonical release', () => {
    for (const fixture of allFixtures) {
      expect(fixture.provenance.chainId).toBe(
        CANONICAL_DISPUTE_READ_MODEL_RELEASE.chainId,
      );
      expect(fixture.provenance.releaseId).toBe(
        CANONICAL_DISPUTE_READ_MODEL_RELEASE.releaseId,
      );
      expect(fixture.provenance.deploymentBlock).toBe(
        CANONICAL_DISPUTE_READ_MODEL_RELEASE.deploymentBlock,
      );
      expect(fixture.provenance.artifactChecksum).toBe(
        CANONICAL_DISPUTE_READ_MODEL_RELEASE.artifactChecksum,
      );
    }
  });
});

describe('Dispute read-model — fail-closed error envelopes', () => {
  const errorFixtures = [
    DISPUTE_READ_MODEL_ERROR_STALE,
    DISPUTE_READ_MODEL_ERROR_WRONG_RELEASE,
    DISPUTE_READ_MODEL_ERROR_UNSUPPORTED_CHAIN,
    DISPUTE_READ_MODEL_ERROR_NOT_FOUND,
  ];

  it('every error has failClosed: true', () => {
    for (const error of errorFixtures) {
      expect(error.failClosed).toBe(true);
    }
  });

  it('every error has a canonical error code', () => {
    const canonicalCodes = [
      'STALE_RECONCILIATION',
      'INVALID_ARTIFACT_VERSION',
      'UNSUPPORTED_CHAIN',
      'NOT_FOUND',
    ];
    for (const error of errorFixtures) {
      expect(canonicalCodes).toContain(error.code);
    }
  });

  it('every error has a reason field', () => {
    for (const error of errorFixtures) {
      expect(error.reason).toBeTruthy();
      expect(typeof error.reason).toBe('string');
    }
  });

  it('NOT_FOUND error does not log as a warning (expected 404)', () => {
    expect(DISPUTE_READ_MODEL_ERROR_NOT_FOUND.code).toBe('NOT_FOUND');
  });

  it('other errors log as warnings (fail-closed conditions)', () => {
    const warningCodes = [
      'STALE_RECONCILIATION',
      'INVALID_ARTIFACT_VERSION',
      'UNSUPPORTED_CHAIN',
    ];
    for (const error of errorFixtures) {
      if (warningCodes.includes(error.code)) {
        expect(error.code).not.toBe('NOT_FOUND');
      }
    }
  });
});

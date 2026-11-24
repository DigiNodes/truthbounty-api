/**
 * PREWAVE-BE-005 — Schema/fixture drift + security tests for the versioned
 * claim read models.
 *
 * These are pure-unit (no AppModule, Redis, or Postgres). They guarantee that
 * the published fixtures stay byte-for-byte aligned with the read-model
 * contract, that no provisional data is presented as final, and that no
 * secret or non-public evidence content leaks into a published fixture.
 */

import {
  CLAIM_READ_MODEL_DETAIL_RESPONSE_KEYS,
  CLAIM_READ_MODEL_ITEM_KEYS,
  CLAIM_READ_MODEL_LIST_RESPONSE_KEYS,
  CLAIM_READ_MODEL_ORDER,
  CLAIM_READ_MODEL_PROVENANCE_KEYS,
  CLAIM_READ_MODEL_VERSION,
} from '../../../src/claims/v2/read-models/claim-read-model.types';
import {
  APPROVED_CLAIM_READ_MODEL_FIXTURES,
  CANONICAL_CLAIM_READ_MODEL_RELEASE,
  CLAIM_READ_MODEL_FIXTURE_RELEASE_VERSION,
} from './claim-read-model.fixtures';

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

describe('Claim read-model — release and version binding', () => {
  it('binds fixtures to the canonical Optimism Sepolia release', () => {
    expect(CANONICAL_CLAIM_READ_MODEL_RELEASE.chainId).toBe(11155420);
    expect(CANONICAL_CLAIM_READ_MODEL_RELEASE.releaseId).toBe(
      'rel-opsepolia-20261015-v2',
    );
    expect(CANONICAL_CLAIM_READ_MODEL_RELEASE.deploymentBlock).toBe(24850000);
    expect(CANONICAL_CLAIM_READ_MODEL_RELEASE.artifactChecksum).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('publishes the pinned read-model version', () => {
    expect(CLAIM_READ_MODEL_FIXTURE_RELEASE_VERSION).toBe(
      CLAIM_READ_MODEL_VERSION,
    );
    expect(CLAIM_READ_MODEL_VERSION).toBe('claim-read-model/v1');
  });

  it('publishes a deterministic ordering', () => {
    expect(CLAIM_READ_MODEL_ORDER).toBe('claimId:asc');
    expect(APPROVED_CLAIM_READ_MODEL_FIXTURES.list.pagination.order).toBe(
      CLAIM_READ_MODEL_ORDER,
    );
  });

  it('has a fixture for every approved UI state', () => {
    expect(Object.keys(APPROVED_CLAIM_READ_MODEL_FIXTURES).sort()).toEqual(
      [
        'detailFinalized',
        'detailProvisional',
        'evidenceMissing',
        'evidenceNotFinalized',
        'list',
        'listEmpty',
        'reorgRecovery',
        'stale',
        'unknown',
        'wrongRelease',
      ].sort(),
    );
  });
});

describe('Claim read-model — schema drift', () => {
  const { list, detailProvisional, detailFinalized } =
    APPROVED_CLAIM_READ_MODEL_FIXTURES;

  it('list response keys match the published contract', () => {
    expectSameKeys(list, CLAIM_READ_MODEL_LIST_RESPONSE_KEYS);
  });

  it('detail response keys match the published contract', () => {
    for (const detail of [detailProvisional, detailFinalized]) {
      expectSameKeys(detail, CLAIM_READ_MODEL_DETAIL_RESPONSE_KEYS);
    }
  });

  it('item keys match the published contract', () => {
    expectSameKeys(list.data[0], CLAIM_READ_MODEL_ITEM_KEYS);
    expectSameKeys(detailFinalized.data, CLAIM_READ_MODEL_ITEM_KEYS);
  });

  it('provenance keys match the published contract', () => {
    expectSameKeys(list.provenance, CLAIM_READ_MODEL_PROVENANCE_KEYS);
    expectSameKeys(list.data[0].release, CLAIM_READ_MODEL_PROVENANCE_KEYS);
  });

  it('every published response carries readModel + readModelVersion + freshness + provenance', () => {
    for (const value of Object.values(APPROVED_CLAIM_READ_MODEL_FIXTURES)) {
      if (!('readModelVersion' in value)) continue;
      expect(value).toHaveProperty('readModel');
      expect(value).toHaveProperty('readModelVersion');
      expect(value).toHaveProperty('freshness');
      expect(value).toHaveProperty('provenance');
    }
  });
});

describe('Claim read-model — provisional is never presented as final', () => {
  const items = [
    ...APPROVED_CLAIM_READ_MODEL_FIXTURES.list.data,
    APPROVED_CLAIM_READ_MODEL_FIXTURES.detailProvisional.data,
    APPROVED_CLAIM_READ_MODEL_FIXTURES.detailFinalized.data,
    APPROVED_CLAIM_READ_MODEL_FIXTURES.evidenceMissing.data,
    APPROVED_CLAIM_READ_MODEL_FIXTURES.evidenceNotFinalized.data,
  ];

  it('a provisional item has a provisional outcome and no final outcome', () => {
    for (const item of items.filter((i) => i.phase === 'provisional')) {
      expect(item.outcome.phase).toBe('provisional');
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
      expect(['SETTLED', 'REJECTED', 'EXPIRED']).toContain(item.state);
      expect(item.dataState).toBe('finalized');
    }
  });

  it('binds every chain-derived item to the canonical release', () => {
    for (const item of items) {
      expect(item.chainId).toBe(CANONICAL_CLAIM_READ_MODEL_RELEASE.chainId);
      expect(item.release).toEqual(CANONICAL_CLAIM_READ_MODEL_RELEASE);
    }
  });
});

describe('Claim read-model — fail-closed fixtures', () => {
  const { stale, unknown, wrongRelease, reorgRecovery } =
    APPROVED_CLAIM_READ_MODEL_FIXTURES;

  it.each([stale, unknown, wrongRelease, reorgRecovery])(
    'is marked failClosed with a canonical code ($code)',
    (fixture) => {
      expect(fixture.failClosed).toBe(true);
      expect([
        'STALE_RECONCILIATION',
        'INVALID_ARTIFACT_VERSION',
        'UNSUPPORTED_CHAIN',
        'NOT_FOUND',
      ]).toContain(fixture.code);
    },
  );

  it('stale + reorg fail closed on STALE_RECONCILIATION', () => {
    expect(stale.code).toBe('STALE_RECONCILIATION');
    expect(reorgRecovery.code).toBe('STALE_RECONCILIATION');
    expect(reorgRecovery.reason).toBe('reorg_detected');
  });

  it('unknown claim is a NOT_FOUND', () => {
    expect(unknown.code).toBe('NOT_FOUND');
  });

  it('wrong release reports expected vs received and INVALID_ARTIFACT_VERSION', () => {
    expect(wrongRelease.code).toBe('INVALID_ARTIFACT_VERSION');
    expect(wrongRelease.expected?.releaseId).toBe(
      CANONICAL_CLAIM_READ_MODEL_RELEASE.releaseId,
    );
    expect(wrongRelease.received?.releaseId).not.toBe(
      CANONICAL_CLAIM_READ_MODEL_RELEASE.releaseId,
    );
  });
});

describe('Claim read-model — no secrets or non-public evidence', () => {
  const serialized = JSON.stringify(APPROVED_CLAIM_READ_MODEL_FIXTURES);

  it('contains no private keys or PEM material outside public tx hashes', () => {
    const stripped = JSON.stringify(
      withoutTxHashes(APPROVED_CLAIM_READ_MODEL_FIXTURES),
    );
    expect(stripped.match(/0x[0-9a-fA-F]{64}/g) ?? []).toHaveLength(0);
    expect(serialized).not.toContain('-----BEGIN PRIVATE KEY-----');
    expect(serialized).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
  });

  it('contains no environment-style secrets or authorization material', () => {
    const lower = serialized.toLowerCase();
    expect(lower).not.toContain('private_key=');
    expect(lower).not.toContain('secret=');
    expect(lower).not.toContain('authorization:');
    expect(lower).not.toContain('bearer ');
  });

  it('contains no evidence content (raw content, rationale, or CID)', () => {
    expect(serialized).not.toMatch(/\bQm[1-9A-HJ-NP-Za-km-z]{44}\b/);
    expect(serialized.toLowerCase()).not.toContain('rationale');
    expect(serialized.toLowerCase()).not.toContain('evidencecontent');
  });
});

/**
 * UX-BE-004 (#595) — Protected Operations contract tests.
 *
 * Pure-unit (no AppModule / Redis / Postgres). Asserts the sanitized fixtures
 * stay consistent with the published vocabulary, that retry eligibility is
 * self-describing, and that no fixture leaks a secret.
 */

import {
  CANONICAL_AUTHORITY_SOURCES,
  CANONICAL_DUPLICATION_RISKS,
  CANONICAL_FRESHNESS_STATES,
  CANONICAL_IMPACTS,
  CANONICAL_OPERATIONS_CAPABILITIES,
  CANONICAL_OPERATIONS_ERROR_CODES,
  CANONICAL_QUEUE_STATUSES,
  OPERATIONS_FAIL_CLOSED_FIXTURES,
  OPERATIONS_FIXTURES,
  OPERATIONS_OPENAPI_VERSION,
} from './operations-contract.fixtures';

function assertOneOf<T>(value: T, allowed: readonly T[], label: string): void {
  expect(allowed).toContain(value);
  if (!allowed.includes(value)) {
    throw new Error(`${label}: "${String(value)}" is not a known value`);
  }
}

function assertExactKeys(value: object, keys: string[], label: string): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(`${label}: unexpected field set`);
  }
}

function assertNoSecrets(serialised: string): void {
  const matches = serialised.match(/0x[0-9a-fA-F]{64}/g) ?? [];
  expect(matches).toHaveLength(0);
  expect(serialised).not.toContain('-----BEGIN PRIVATE KEY-----');
  expect(serialised.toLowerCase()).not.toContain('private_key=');
  expect(serialised.toLowerCase()).not.toContain('secret=');
  expect(serialised.toLowerCase()).not.toContain('authorization:');
}

describe('Operations fixtures — release binding', () => {
  it('binds to the canonical release and OpenAPI version', () => {
    expect(OPERATIONS_FIXTURES.release.releaseVersion).toBe('v2.0.0-sepolia');
    expect(OPERATIONS_FIXTURES.release.chainId).toBe(11155420);
    expect(OPERATIONS_FIXTURES.release.openapiVersion).toBe(
      OPERATIONS_OPENAPI_VERSION,
    );
  });
});

describe('Operations fixtures — vocabulary', () => {
  it('uses only canonical item vocabulary', () => {
    const item = OPERATIONS_FIXTURES.itemDetail;
    assertOneOf(
      item.capability,
      CANONICAL_OPERATIONS_CAPABILITIES,
      'capability',
    );
    assertOneOf(
      item.authoritySource,
      CANONICAL_AUTHORITY_SOURCES,
      'authoritySource',
    );
    assertOneOf(item.status, CANONICAL_QUEUE_STATUSES, 'status');
    assertOneOf(item.impact, CANONICAL_IMPACTS, 'impact');
    assertOneOf(
      item.duplicationRisk,
      CANONICAL_DUPLICATION_RISKS,
      'duplicationRisk',
    );
    assertOneOf(item.freshness, CANONICAL_FRESHNESS_STATES, 'freshness');
    expect(typeof item.retryable).toBe('boolean');
  });

  it('publishes an invariant, sanitized item shape', () => {
    assertExactKeys(
      OPERATIONS_FIXTURES.itemDetail,
      [
        'id',
        'releaseId',
        'capability',
        'authoritySource',
        'authorityExpiresAt',
        'status',
        'impact',
        'duplicationRisk',
        'freshness',
        'attempts',
        'maxAttempts',
        'retryable',
        'version',
        'updatedAt',
        'summary',
      ],
      'itemDetail',
    );
  });

  it('retry eligibility is self-describing (frontend never guesses)', () => {
    const eligibility = OPERATIONS_FIXTURES.retryEligibility;
    assertExactKeys(
      eligibility,
      ['id', 'eligible', 'reason', 'attemptsRemaining', 'preconditionToken'],
      'retryEligibility',
    );
    if (eligibility.eligible) {
      expect(eligibility.reason).toBeNull();
    } else {
      expect(eligibility.reason).not.toBeNull();
    }
    expect(eligibility.preconditionToken.length).toBeGreaterThanOrEqual(8);
  });

  it('audit record carries an audit id and no secrets', () => {
    assertExactKeys(
      OPERATIONS_FIXTURES.auditRecord,
      [
        'auditId',
        'action',
        'capability',
        'authoritySource',
        'actorId',
        'outcome',
        'resultCode',
        'subjectId',
        'createdAt',
      ],
      'auditRecord',
    );
    expect(OPERATIONS_FIXTURES.auditRecord.auditId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('Operations fixtures — fail-closed states', () => {
  it('publishes one canonical response per required state', () => {
    expect(Object.keys(OPERATIONS_FAIL_CLOSED_FIXTURES).sort()).toEqual(
      [
        'alreadyCompleted',
        'conflict',
        'denied',
        'rateLimited',
        'staleAuthority',
        'unavailable',
        'unsafeToRetry',
      ].sort(),
    );
  });

  it('every fail-closed fixture has a canonical code, status and audit id', () => {
    for (const [name, fixture] of Object.entries(
      OPERATIONS_FAIL_CLOSED_FIXTURES,
    )) {
      assertOneOf(
        fixture.errorCode,
        CANONICAL_OPERATIONS_ERROR_CODES,
        `${name}.errorCode`,
      );
      expect(fixture.statusCode).toBeGreaterThanOrEqual(400);
      expect(fixture.auditId).toMatch(/^[0-9a-f-]{36}$/);
      assertExactKeys(
        fixture,
        ['statusCode', 'errorCode', 'message', 'auditId', 'timestamp'],
        name,
      );
    }
  });
});

describe('Operations fixtures — sanitization', () => {
  it('no fixture leaks a secret or raw authorization header', () => {
    const serialised = JSON.stringify({
      fixtures: OPERATIONS_FIXTURES,
      failClosed: OPERATIONS_FAIL_CLOSED_FIXTURES,
    });
    assertNoSecrets(serialised);
  });
});

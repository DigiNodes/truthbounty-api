/**
 * PREWAVE-BE-090 — API–Frontend Contract Tests From Approved Fixtures
 *
 * Validates that every approved frontend data dependency has a corresponding
 * contract test. Tests are pure-unit (no AppModule / Redis / Postgres).
 *
 * Acceptance criteria (from issue #686):
 *  1. Every approved frontend data dependency has a contract test.
 *  2. Missing/invented fields fail CI.
 *  3. Error/state vocabulary is consistent.
 *  4. Fixtures bind API and release versions.
 *
 * Security constraints:
 *  - No secrets, private keys, or unredacted signatures appear in any fixture.
 *  - Fail closed on stale, missing, ambiguous, or unauthorized state.
 */

import {
  APPROVED_FIXTURES_V2,
  CANONICAL_CLAIM_STATUSES,
  CANONICAL_SETTLEMENT_STATES,
  CANONICAL_ERROR_CODES,
  CANONICAL_RELEASE_METADATA,
} from './api-frontend-contract.fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert a value is one of the provided enum members. */
function assertOneOf<T>(value: T, allowed: readonly T[], label: string): void {
  expect(allowed).toContain(value);
  if (!allowed.includes(value)) {
    throw new Error(`${label}: "${value}" is not in [${allowed.join(', ')}]`);
  }
}

/** Verify no raw private key patterns appear in a serialised fixture. */
function assertNoSecrets(serialised: string, context: string): void {
  // Ethereum private key: 64-char hex
  const privateKeyPattern = /0x[0-9a-fA-F]{64}/g;
  const matches = serialised.match(privateKeyPattern) ?? [];
  expect(matches).toHaveLength(0);
  if (matches.length > 0) {
    throw new Error(`${context}: secret/private-key pattern found: ${matches[0]}`);
  }
  // PEM private key block
  expect(serialised).not.toContain('-----BEGIN PRIVATE KEY-----');
  expect(serialised).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
  // Environment-style secrets
  expect(serialised.toLowerCase()).not.toContain('private_key=');
  expect(serialised.toLowerCase()).not.toContain('secret=');
}

// ---------------------------------------------------------------------------
// 1. Release / version binding
// ---------------------------------------------------------------------------

describe('Release & Version Binding', () => {
  it('fixture release metadata binds to v2.0.0-sepolia', () => {
    expect(APPROVED_FIXTURES_V2.release.releaseVersion).toBe('v2.0.0-sepolia');
    expect(APPROVED_FIXTURES_V2.release.protocolVersion).toBe('2.0.0');
    expect(APPROVED_FIXTURES_V2.release.abiVersion).toBe('2.0.0');
  });

  it('fixture release metadata binds to chain 11155420 (Optimism Sepolia)', () => {
    expect(APPROVED_FIXTURES_V2.release.chainId).toBe(11155420);
    expect(APPROVED_FIXTURES_V2.release.network).toBe('optimism-sepolia');
  });

  it('canonical release metadata matches fixture release', () => {
    expect(APPROVED_FIXTURES_V2.release).toEqual(CANONICAL_RELEASE_METADATA);
  });
});

// ---------------------------------------------------------------------------
// 2. Claim fixture contract tests
// ---------------------------------------------------------------------------

describe('Claim Contract', () => {
  const { claim } = APPROVED_FIXTURES_V2;

  it('has all required fields', () => {
    expect(claim).toHaveProperty('id');
    expect(claim).toHaveProperty('title');
    expect(claim).toHaveProperty('description');
    expect(claim).toHaveProperty('claimantAddress');
    expect(claim).toHaveProperty('status');
    expect(claim).toHaveProperty('bountyAmount');
    expect(claim).toHaveProperty('totalStaked');
    expect(claim).toHaveProperty('evidence');
    expect(claim).toHaveProperty('createdAt');
    expect(claim).toHaveProperty('updatedAt');
    expect(claim).toHaveProperty('releaseVersion');
    expect(claim).toHaveProperty('chainId');
  });

  it('status is a canonical claim status', () => {
    assertOneOf(claim.status, CANONICAL_CLAIM_STATUSES, 'claim.status');
  });

  it('chainId matches the canonical release chain', () => {
    expect(claim.chainId).toBe(CANONICAL_RELEASE_METADATA.chainId);
  });

  it('releaseVersion matches the canonical release', () => {
    expect(claim.releaseVersion).toBe(CANONICAL_RELEASE_METADATA.releaseVersion);
  });

  it('evidence array contains objects with required fields', () => {
    expect(Array.isArray(claim.evidence)).toBe(true);
    for (const ev of claim.evidence) {
      expect(ev).toHaveProperty('id');
      expect(ev).toHaveProperty('type');
      expect(ev).toHaveProperty('value');
      expect(ev).toHaveProperty('createdAt');
    }
  });

  it('bountyAmount is a non-negative number', () => {
    expect(typeof claim.bountyAmount).toBe('number');
    expect(claim.bountyAmount).toBeGreaterThanOrEqual(0);
  });

  it('NEGATIVE — invented field "internalScore" must NOT exist', () => {
    expect(claim).not.toHaveProperty('internalScore');
  });

  it('NEGATIVE — invented field "rawPrivateKey" must NOT exist', () => {
    expect(claim).not.toHaveProperty('rawPrivateKey');
  });
});

// ---------------------------------------------------------------------------
// 3. Verifier fixture contract tests
// ---------------------------------------------------------------------------

describe('Verifier Contract', () => {
  const { verifier } = APPROVED_FIXTURES_V2;

  it('has all required fields', () => {
    expect(verifier).toHaveProperty('roundId');
    expect(verifier).toHaveProperty('claimId');
    expect(verifier).toHaveProperty('verifierAddress');
    expect(verifier).toHaveProperty('decision');
    expect(verifier).toHaveProperty('stakeAmount');
    expect(verifier).toHaveProperty('status');
    expect(verifier).toHaveProperty('startTime');
    expect(verifier).toHaveProperty('deadline');
    expect(verifier).toHaveProperty('minStake');
    expect(verifier).toHaveProperty('releaseVersion');
    expect(verifier).toHaveProperty('chainId');
  });

  it('decision is TRUE or FALSE', () => {
    assertOneOf(verifier.decision, ['TRUE', 'FALSE'] as const, 'verifier.decision');
  });

  it('status is a valid verifier status', () => {
    assertOneOf(
      verifier.status,
      ['PENDING', 'CONFIRMED', 'FAILED'] as const,
      'verifier.status',
    );
  });

  it('chainId and releaseVersion match canonical release', () => {
    expect(verifier.chainId).toBe(CANONICAL_RELEASE_METADATA.chainId);
    expect(verifier.releaseVersion).toBe(CANONICAL_RELEASE_METADATA.releaseVersion);
  });

  it('deadline is after startTime', () => {
    expect(verifier.deadline).toBeGreaterThan(verifier.startTime);
  });

  it('NEGATIVE — invented field "privateVerifierKey" must NOT exist', () => {
    expect(verifier).not.toHaveProperty('privateVerifierKey');
  });
});

// ---------------------------------------------------------------------------
// 4. Dispute fixture contract tests
// ---------------------------------------------------------------------------

describe('Dispute Contract', () => {
  const { dispute } = APPROVED_FIXTURES_V2;

  it('has all required fields', () => {
    expect(dispute).toHaveProperty('claimId');
    expect(dispute).toHaveProperty('originalRoundId');
    expect(dispute).toHaveProperty('disputeId');
    expect(dispute).toHaveProperty('decision');
    expect(dispute).toHaveProperty('status');
    expect(dispute).toHaveProperty('totalStake');
    expect(dispute).toHaveProperty('windowEndTime');
    expect(dispute).toHaveProperty('isProvisional');
    expect(dispute).toHaveProperty('isFinalized');
    expect(dispute).toHaveProperty('releaseVersion');
    expect(dispute).toHaveProperty('chainId');
  });

  it('status is ACTIVE | RESOLVED | PENDING', () => {
    assertOneOf(dispute.status, ['ACTIVE', 'RESOLVED', 'PENDING'] as const, 'dispute.status');
  });

  it('decision is VERIFIED or REJECTED', () => {
    assertOneOf(dispute.decision, ['VERIFIED', 'REJECTED'] as const, 'dispute.decision');
  });

  it('isProvisional and isFinalized are booleans', () => {
    expect(typeof dispute.isProvisional).toBe('boolean');
    expect(typeof dispute.isFinalized).toBe('boolean');
  });

  it('chainId and releaseVersion match canonical release', () => {
    expect(dispute.chainId).toBe(CANONICAL_RELEASE_METADATA.chainId);
    expect(dispute.releaseVersion).toBe(CANONICAL_RELEASE_METADATA.releaseVersion);
  });

  it('NEGATIVE — a non-finalized dispute must not have isFinalized=true', () => {
    // Fixture is provisional, not finalized
    if (dispute.isProvisional) {
      expect(dispute.isFinalized).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Admin fixture contract tests
// ---------------------------------------------------------------------------

describe('Admin Contract', () => {
  const { admin } = APPROVED_FIXTURES_V2;

  it('has all required fields', () => {
    expect(admin).toHaveProperty('isAuthorized');
    expect(admin).toHaveProperty('adminAddress');
    expect(admin).toHaveProperty('role');
    expect(admin).toHaveProperty('healthMetrics');
    expect(admin).toHaveProperty('operationalQueue');
  });

  it('isAuthorized is a boolean', () => {
    expect(typeof admin.isAuthorized).toBe('boolean');
  });

  it('role is ADMINISTRATOR or OPERATOR', () => {
    assertOneOf(admin.role, ['ADMINISTRATOR', 'OPERATOR'] as const, 'admin.role');
  });

  it('each healthMetric has a valid status', () => {
    const allowedStatuses = ['healthy', 'warning', 'degraded', 'unavailable'] as const;
    for (const metric of admin.healthMetrics) {
      expect(metric).toHaveProperty('id');
      expect(metric).toHaveProperty('name');
      expect(metric).toHaveProperty('value');
      expect(metric).toHaveProperty('status');
      expect(metric).toHaveProperty('lastUpdated');
      assertOneOf(metric.status, allowedStatuses, `healthMetric[${metric.id}].status`);
    }
  });

  it('each operationalQueue item has required fields', () => {
    for (const item of admin.operationalQueue) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('authority');
      expect(item).toHaveProperty('risk');
      expect(item).toHaveProperty('status');
      assertOneOf(
        item.authority,
        ['PROTOCOL_OPERATOR', 'EMERGENCY_ADMIN'] as const,
        `queue[${item.id}].authority`,
      );
      assertOneOf(item.risk, ['low', 'medium', 'high'] as const, `queue[${item.id}].risk`);
    }
  });

  it('NEGATIVE — invented field "sudoToken" must NOT exist', () => {
    expect(admin).not.toHaveProperty('sudoToken');
  });
});

// ---------------------------------------------------------------------------
// 6. Status / Freshness fixture contract tests
// ---------------------------------------------------------------------------

describe('Status & Freshness Contract', () => {
  const { status } = APPROVED_FIXTURES_V2;

  it('has required top-level fields', () => {
    expect(status).toHaveProperty('freshness');
    expect(status).toHaveProperty('degradedState');
    expect(status).toHaveProperty('releaseVersion');
    expect(status).toHaveProperty('chainId');
  });

  it('freshness has all required fields', () => {
    const { freshness } = status;
    expect(freshness).toHaveProperty('indexedHeight');
    expect(freshness).toHaveProperty('finalizedHeight');
    expect(freshness).toHaveProperty('lastUpdate');
    expect(freshness).toHaveProperty('lag');
    expect(freshness).toHaveProperty('chainHeadHeight');
    expect(freshness).toHaveProperty('dependencies');
  });

  it('freshness.lag is non-negative', () => {
    expect(status.freshness.lag).toBeGreaterThanOrEqual(0);
  });

  it('each dependency has a valid status', () => {
    const allowedStatuses = ['healthy', 'degraded', 'unavailable'] as const;
    for (const dep of status.freshness.dependencies) {
      expect(dep).toHaveProperty('name');
      expect(dep).toHaveProperty('status');
      expect(dep).toHaveProperty('latencyMs');
      assertOneOf(dep.status, allowedStatuses, `dependency[${dep.name}].status`);
      expect(dep.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('degradedState.isDegraded is a boolean', () => {
    expect(typeof status.degradedState.isDegraded).toBe('boolean');
  });

  it('chainId and releaseVersion match canonical release', () => {
    expect(status.chainId).toBe(CANONICAL_RELEASE_METADATA.chainId);
    expect(status.releaseVersion).toBe(CANONICAL_RELEASE_METADATA.releaseVersion);
  });
});

// ---------------------------------------------------------------------------
// 7. Support fixture contract tests
// ---------------------------------------------------------------------------

describe('Support Contract', () => {
  const { support } = APPROVED_FIXTURES_V2;

  it('has all required fields', () => {
    expect(support).toHaveProperty('channel');
    expect(support).toHaveProperty('status');
    expect(support).toHaveProperty('documentationUrl');
    expect(support).toHaveProperty('emergencyContacts');
    expect(support).toHaveProperty('releaseVersion');
  });

  it('status is online | degraded | offline', () => {
    assertOneOf(support.status, ['online', 'degraded', 'offline'] as const, 'support.status');
  });

  it('emergencyContacts contains no private keys or secrets', () => {
    const serialised = JSON.stringify(support.emergencyContacts);
    assertNoSecrets(serialised, 'support.emergencyContacts');
  });

  it('documentationUrl is a valid https URL', () => {
    expect(support.documentationUrl).toMatch(/^https:\/\//);
  });

  it('releaseVersion matches canonical release', () => {
    expect(support.releaseVersion).toBe(CANONICAL_RELEASE_METADATA.releaseVersion);
  });
});

// ---------------------------------------------------------------------------
// 8. Legal fixture contract tests
// ---------------------------------------------------------------------------

describe('Legal Contract', () => {
  const { legal } = APPROVED_FIXTURES_V2;

  it('has all required fields', () => {
    expect(legal).toHaveProperty('termsVersion');
    expect(legal).toHaveProperty('disclaimer');
    expect(legal).toHaveProperty('sanctionsCheckRequired');
    expect(legal).toHaveProperty('evidencePrivacyModel');
    expect(legal).toHaveProperty('governingLaw');
    expect(legal).toHaveProperty('releaseVersion');
  });

  it('evidencePrivacyModel is public | redacted | zero_knowledge', () => {
    assertOneOf(
      legal.evidencePrivacyModel,
      ['public', 'redacted', 'zero_knowledge'] as const,
      'legal.evidencePrivacyModel',
    );
  });

  it('termsVersion matches the protocol version in the release', () => {
    expect(legal.termsVersion).toBe(CANONICAL_RELEASE_METADATA.protocolVersion);
  });

  it('releaseVersion matches canonical release', () => {
    expect(legal.releaseVersion).toBe(CANONICAL_RELEASE_METADATA.releaseVersion);
  });

  it('sanctionsCheckRequired is a boolean', () => {
    expect(typeof legal.sanctionsCheckRequired).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// 9. Stale fixture — fail-closed tests
// ---------------------------------------------------------------------------

describe('Stale Fixture (Fail-Closed)', () => {
  const { stale } = APPROVED_FIXTURES_V2;

  it('isStale is true', () => {
    expect(stale.isStale).toBe(true);
  });

  it('error.code is STALE_RECONCILIATION', () => {
    expect(stale.error.code).toBe('STALE_RECONCILIATION');
  });

  it('action is FAIL_CLOSED', () => {
    expect(stale.action).toBe('FAIL_CLOSED');
  });

  it('error has currentBlock, lastIndexedBlock, lag fields', () => {
    expect(stale.error).toHaveProperty('currentBlock');
    expect(stale.error).toHaveProperty('lastIndexedBlock');
    expect(stale.error).toHaveProperty('lag');
  });

  it('lag is positive (stale state means lag > 0)', () => {
    expect(stale.error.lag).toBeGreaterThan(0);
  });

  it('STALE_RECONCILIATION is a canonical error code', () => {
    expect(CANONICAL_ERROR_CODES).toContain(stale.error.code);
  });

  it('NEGATIVE — a healthy (non-stale) fixture does NOT have isStale=true', () => {
    // The claim fixture represents a healthy state
    expect((APPROVED_FIXTURES_V2.claim as unknown as { isStale?: boolean }).isStale).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 10. Denied fixture — fail-closed tests
// ---------------------------------------------------------------------------

describe('Denied Fixture (Fail-Closed)', () => {
  const { denied } = APPROVED_FIXTURES_V2;

  it('isDenied is true', () => {
    expect(denied.isDenied).toBe(true);
  });

  it('error.code is UNAUTHORIZED or FORBIDDEN', () => {
    assertOneOf(
      denied.error.code,
      ['UNAUTHORIZED', 'FORBIDDEN'] as const,
      'denied.error.code',
    );
  });

  it('action is REJECT_MUTATION', () => {
    expect(denied.action).toBe('REJECT_MUTATION');
  });

  it('error codes are canonical', () => {
    expect(CANONICAL_ERROR_CODES).toContain(denied.error.code);
  });

  it('NEGATIVE — a healthy claim does NOT have isDenied=true', () => {
    expect((APPROVED_FIXTURES_V2.claim as unknown as { isDenied?: boolean }).isDenied).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11. Unavailable fixture contract tests
// ---------------------------------------------------------------------------

describe('Unavailable Fixture', () => {
  const { unavailable } = APPROVED_FIXTURES_V2;

  it('isUnavailable is true', () => {
    expect(unavailable.isUnavailable).toBe(true);
  });

  it('error.code is SERVICE_UNAVAILABLE', () => {
    expect(unavailable.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('retryAfterSeconds is a positive number', () => {
    expect(unavailable.error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('action is CIRCUIT_BREAKER', () => {
    expect(unavailable.action).toBe('CIRCUIT_BREAKER');
  });

  it('SERVICE_UNAVAILABLE is a canonical error code', () => {
    expect(CANONICAL_ERROR_CODES).toContain(unavailable.error.code);
  });
});

// ---------------------------------------------------------------------------
// 12. Wrong-release fixture contract tests
// ---------------------------------------------------------------------------

describe('Wrong-Release Fixture', () => {
  const { wrongRelease } = APPROVED_FIXTURES_V2;

  it('isWrongRelease is true', () => {
    expect(wrongRelease.isWrongRelease).toBe(true);
  });

  it('error.code is INVALID_ARTIFACT_VERSION', () => {
    expect(wrongRelease.error.code).toBe('INVALID_ARTIFACT_VERSION');
  });

  it('action is FAIL_CLOSED', () => {
    expect(wrongRelease.action).toBe('FAIL_CLOSED');
  });

  it('expectedChainId is 11155420 (Optimism Sepolia)', () => {
    expect(wrongRelease.error.expectedChainId).toBe(11155420);
  });

  it('receivedChainId differs from expectedChainId', () => {
    expect(wrongRelease.error.receivedChainId).not.toBe(wrongRelease.error.expectedChainId);
  });

  it('INVALID_ARTIFACT_VERSION is a canonical error code', () => {
    expect(CANONICAL_ERROR_CODES).toContain(wrongRelease.error.code);
  });
});

// ---------------------------------------------------------------------------
// 13. Cross-cutting: security — no secrets in any fixture
// ---------------------------------------------------------------------------

describe('Security — No Secrets in Any Fixture', () => {
  const fixtureKeys = [
    'claim',
    'verifier',
    'dispute',
    'admin',
    'status',
    'support',
    'legal',
    'stale',
    'denied',
    'unavailable',
    'wrongRelease',
  ] as const;

  for (const key of fixtureKeys) {
    it(`fixture "${key}" contains no private keys or raw secrets`, () => {
      const serialised = JSON.stringify(APPROVED_FIXTURES_V2[key]);
      assertNoSecrets(serialised, `fixture[${key}]`);
    });
  }
});

// ---------------------------------------------------------------------------
// 14. Cross-cutting: all error codes are canonical
// ---------------------------------------------------------------------------

describe('Error Code Vocabulary Consistency', () => {
  it('stale error code is in CANONICAL_ERROR_CODES', () => {
    expect(CANONICAL_ERROR_CODES).toContain(APPROVED_FIXTURES_V2.stale.error.code);
  });

  it('denied error code is in CANONICAL_ERROR_CODES', () => {
    expect(CANONICAL_ERROR_CODES).toContain(APPROVED_FIXTURES_V2.denied.error.code);
  });

  it('unavailable error code is in CANONICAL_ERROR_CODES', () => {
    expect(CANONICAL_ERROR_CODES).toContain(APPROVED_FIXTURES_V2.unavailable.error.code);
  });

  it('wrong-release error code is in CANONICAL_ERROR_CODES', () => {
    expect(CANONICAL_ERROR_CODES).toContain(APPROVED_FIXTURES_V2.wrongRelease.error.code);
  });
});

// ---------------------------------------------------------------------------
// 15. Cross-cutting: all chain-derived state uses the canonical chain
// ---------------------------------------------------------------------------

describe('Chain Provenance — All Chain-Derived State Binds to Canonical Chain', () => {
  it('claim.chainId === canonical chainId', () => {
    expect(APPROVED_FIXTURES_V2.claim.chainId).toBe(CANONICAL_RELEASE_METADATA.chainId);
  });

  it('verifier.chainId === canonical chainId', () => {
    expect(APPROVED_FIXTURES_V2.verifier.chainId).toBe(CANONICAL_RELEASE_METADATA.chainId);
  });

  it('dispute.chainId === canonical chainId', () => {
    expect(APPROVED_FIXTURES_V2.dispute.chainId).toBe(CANONICAL_RELEASE_METADATA.chainId);
  });

  it('status.chainId === canonical chainId', () => {
    expect(APPROVED_FIXTURES_V2.status.chainId).toBe(CANONICAL_RELEASE_METADATA.chainId);
  });

  it('wrong-release fixture expectedChainId === canonical chainId', () => {
    expect(APPROVED_FIXTURES_V2.wrongRelease.error.expectedChainId).toBe(
      CANONICAL_RELEASE_METADATA.chainId,
    );
  });
});

// ---------------------------------------------------------------------------
// 16. Cross-cutting: CANONICAL_SETTLEMENT_STATES vocabulary guard
// ---------------------------------------------------------------------------

describe('Settlement State Vocabulary', () => {
  it('CANONICAL_SETTLEMENT_STATES has 7 members', () => {
    expect(CANONICAL_SETTLEMENT_STATES).toHaveLength(7);
  });

  it('contains FINALIZED', () => {
    expect(CANONICAL_SETTLEMENT_STATES).toContain('FINALIZED');
  });

  it('contains SETTLED', () => {
    expect(CANONICAL_SETTLEMENT_STATES).toContain('SETTLED');
  });

  it('does NOT contain invented state "COMPLETED"', () => {
    expect(CANONICAL_SETTLEMENT_STATES).not.toContain('COMPLETED');
  });

  it('does NOT contain invented state "CLOSED"', () => {
    expect(CANONICAL_SETTLEMENT_STATES).not.toContain('CLOSED');
  });
});


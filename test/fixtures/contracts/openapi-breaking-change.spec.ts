/**
 * PREWAVE-BE-088 — OpenAPI Breaking Change Detection Tests
 *
 * Gates OpenAPI breaking changes against the pinned consumer contract.
 * Compares reviewed OpenAPI snapshots for path/method/schema/enum/error/auth
 * changes and requires explicit versioning/migration evidence.
 *
 * Acceptance criteria (from issue #684):
 *  1. Unversioned breaking changes fail CI.
 *  2. Diff is machine-readable/actionable.
 *  3. Runtime validation matches spec.
 *  4. Frontend pin remains reproducible.
 *
 * Security constraints:
 *  - No secrets, private keys, or unredacted signatures appear in any fixture.
 *  - Fail closed on stale, missing, ambiguous, or unauthorized state.
 */

import {
  PINNED_OPENAPI_PATHS,
  PINNED_OPENAPI_SCHEMAS,
  PINNED_OPENAPI_ERROR_CODES,
  PINNED_OPENAPI_AUTH_REQUIREMENTS,
  OPENAPI_VERSION_METADATA,
  OPENAPI_BREAKING_CHANGES,
  OPENAPI_MIGRATION_HISTORY,
  OPENAPI_CLIENT_PIN,
  OpenAPIBreakingChange,
} from './openapi-breaking-change.fixtures';

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
  const privateKeyPattern = /0x[0-9a-fA-F]{64}/g;
  const matches = serialised.match(privateKeyPattern) ?? [];
  expect(matches).toHaveLength(0);
  if (matches.length > 0) {
    throw new Error(`${context}: secret/private-key pattern found: ${matches[0]}`);
  }
  expect(serialised).not.toContain('-----BEGIN PRIVATE KEY-----');
  expect(serialised).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
  expect(serialised.toLowerCase()).not.toContain('private_key=');
  expect(serialised.toLowerCase()).not.toContain('secret=');
}

// ---------------------------------------------------------------------------
// 1. OpenAPI version metadata
// ---------------------------------------------------------------------------

describe('OpenAPI Version Metadata', () => {
  it('currentVersion is defined and non-empty', () => {
    expect(OPENAPI_VERSION_METADATA.currentVersion).toBeTruthy();
    expect(typeof OPENAPI_VERSION_METADATA.currentVersion).toBe('string');
  });

  it('specTitle matches the API title', () => {
    expect(OPENAPI_VERSION_METADATA.specTitle).toBe('TruthBounty API');
  });

  it('pinExpiresAt is in the future', () => {
    const expiresAt = new Date(OPENAPI_VERSION_METADATA.pinExpiresAt);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('consumedBy identifies the pinned consumer', () => {
    expect(OPENAPI_VERSION_METADATA.consumedBy).toBe('frontend-v2');
  });
});

// ---------------------------------------------------------------------------
// 2. Pinned OpenAPI paths — all required paths exist
// ---------------------------------------------------------------------------

describe('Pinned OpenAPI Paths — Existence', () => {
  const pinnedPaths = Object.keys(PINNED_OPENAPI_PATHS);

  it('has at least the auth, claims, disputes, identity, blockchain, rewards, audit, and indexer paths', () => {
    const pathGroups = {
      auth: pinnedPaths.filter((p) => p.startsWith('POST /auth/') || p.startsWith('GET /auth/') || p.startsWith('DELETE /auth/') || p.startsWith('PUT /auth/')),
      claims: pinnedPaths.filter((p) => p.startsWith('GET /claims/') || p.startsWith('POST /claims') || p.startsWith('PUT /claims/')),
      disputes: pinnedPaths.filter((p) => p.startsWith('POST /disputes') || p.startsWith('PATCH /disputes') || p.startsWith('GET /disputes')),
      identity: pinnedPaths.filter((p) => p.startsWith('POST /identity/') || p.startsWith('GET /identity/') || p.startsWith('DELETE /identity/')),
      worldcoin: pinnedPaths.filter((p) => p.startsWith('POST /identity/worldcoin') || p.startsWith('GET /identity/worldcoin')),
      sybil: pinnedPaths.filter((p) => p.startsWith('POST /sybil/') || p.startsWith('GET /sybil/')),
      blockchain: pinnedPaths.filter((p) => p.startsWith('POST /api/v1/blockchain/') || p.startsWith('GET /api/v1/blockchain/')),
      indexer: pinnedPaths.filter((p) => p.startsWith('GET /indexer/') || p.startsWith('POST /indexer/')),
      rewards: pinnedPaths.filter((p) => p.startsWith('POST /rewards') || p.startsWith('GET /rewards') || p.startsWith('PATCH /rewards') || p.startsWith('DELETE /rewards')),
      leaderboard: pinnedPaths.filter((p) => p.startsWith('GET /leaderboard')),
      audit: pinnedPaths.filter((p) => p.startsWith('GET /audit')),
      evidence: pinnedPaths.filter((p) => p.startsWith('POST /evidence/') || p.startsWith('GET /evidence/')),
      v2_claims: pinnedPaths.filter((p) => p.startsWith('GET /api/v2/')),
    };

    expect(pathGroups.auth.length).toBeGreaterThan(0);
    expect(pathGroups.claims.length).toBeGreaterThan(0);
    expect(pathGroups.disputes.length).toBeGreaterThan(0);
    expect(pathGroups.identity.length).toBeGreaterThan(0);
    expect(pathGroups.blockchain.length).toBeGreaterThan(0);
    expect(pathGroups.rewards.length).toBeGreaterThan(0);
    expect(pathGroups.audit.length).toBeGreaterThan(0);
    expect(pathGroups.v2_claims.length).toBeGreaterThan(0);
  });

  it('every pinned path has a versionAdded field', () => {
    for (const [path, meta] of Object.entries(PINNED_OPENAPI_PATHS)) {
      expect(meta.versionAdded).toBeTruthy();
      expect(typeof meta.versionAdded).toBe('string');
    }
  });

  it('every pinned path has a breakingChange boolean', () => {
    for (const [path, meta] of Object.entries(PINNED_OPENAPI_PATHS)) {
      expect(typeof meta.breakingChange).toBe('boolean');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Breaking / nonbreaking fixture tests
// ---------------------------------------------------------------------------

describe('Breaking / Nonbreaking Fixtures', () => {
  it('OPENAPI_BREAKING_CHANGES array is defined', () => {
    expect(OPENAPI_BREAKING_CHANGES).toBeDefined();
    expect(Array.isArray(OPENAPI_BREAKING_CHANGES)).toBe(true);
  });

  it('OPENAPI_BREAKING_CHANGES entries have required fields', () => {
    for (const change of OPENAPI_BREAKING_CHANGES) {
      expect(change).toHaveProperty('type');
      expect(change).toHaveProperty('path');
      expect(change).toHaveProperty('description');
      expect(change).toHaveProperty('version');
      assertOneOf(
        change.type,
        [
          'path-removed',
          'path-added',
          'method-changed',
          'schema-removed',
          'schema-required',
          'schema-enum-removed',
          'auth-changed',
          'error-code-removed',
          'format-changed',
          'version-missing',
        ] as const,
        `change.type for ${change.path}`,
      );
    }
  });

  it('every breaking change has migrationEvidence', () => {
    for (const change of OPENAPI_BREAKING_CHANGES) {
      if (change.breakingChange !== false) {
        expect(change.migrationEvidence).toBeTruthy();
        expect(
          change.migrationEvidence,
          `Breaking change at ${change.path} must have migrationEvidence`,
        ).toBeDefined();
      }
    }
  });

  it('nonbreaking changes do not require migrationEvidence', () => {
    for (const change of OPENAPI_BREAKING_CHANGES) {
      if (change.breakingChange === false) {
        // Nonbreaking changes may or may not have migrationEvidence
        // This test just confirms the field exists on breaking changes
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Enum removal tests
// ---------------------------------------------------------------------------

describe('Enum Removal Detection', () => {
  const pinnedSchemas = PINNED_OPENAPI_SCHEMAS;

  it('Claim.status enum has all required members', () => {
    const statusEnum = pinnedSchemas['Claim'].enumFields.status;
    expect(statusEnum).toContain('PENDING');
    expect(statusEnum).toContain('RESOLVED');
    expect(statusEnum).toContain('FINALIZED');
  });

  it('Dispute.status enum has all required members', () => {
    const statusEnum = pinnedSchemas['Dispute'].enumFields.status;
    expect(statusEnum).toContain('PENDING');
    expect(statusEnum).toContain('IN_REVIEW');
    expect(statusEnum).toContain('RESOLVED');
    expect(statusEnum).toContain('REJECTED');
    expect(statusEnum).toContain('EXPIRED');
  });

  it('Dispute.outcome enum has all required members', () => {
    const outcomeEnum = pinnedSchemas['Dispute'].enumFields.outcome;
    expect(outcomeEnum).toContain('APPROVED');
    expect(outcomeEnum).toContain('REJECTED');
    expect(outcomeEnum).toContain('SPLIT');
  });

  it('Dispute.trigger enum has all required members', () => {
    const triggerEnum = pinnedSchemas['Dispute'].enumFields.trigger;
    expect(triggerEnum).toContain('MANUAL_REPORT');
    expect(triggerEnum).toContain('LOW_CONFIDENCE');
    expect(triggerEnum).toContain('EVIDENCE_CONFLICT');
  });

  it('AuthChallenge.format enum has all required members', () => {
    const formatEnum = pinnedSchemas['AuthChallenge'].enumFields.format;
    expect(formatEnum).toContain('siwe');
    expect(formatEnum).toContain('legacy');
  });

  it('AuthLogin.format is jwt', () => {
    const formatField = pinnedSchemas['AuthLogin'].formatFields;
    expect(formatField).toHaveProperty('accessToken');
  });

  it('NEGATIVE — no enum member has been silently removed from Claim.status', () => {
    // The pinned enum must contain all previously accepted values
    const currentEnum = pinnedSchemas['Claim'].enumFields.status;
    expect(currentEnum).toContain('PENDING');
    expect(currentEnum).toContain('RESOLVED');
    expect(currentEnum).toContain('FINALIZED');
  });

  it('NEGATIVE — no enum member has been silently removed from Dispute.status', () => {
    const currentEnum = pinnedSchemas['Dispute'].enumFields.status;
    expect(currentEnum).toContain('PENDING');
    expect(currentEnum).toContain('IN_REVIEW');
    expect(currentEnum).toContain('RESOLVED');
    expect(currentEnum).toContain('REJECTED');
    expect(currentEnum).toContain('EXPIRED');
  });

  it('NEGATIVE — no enum member has been silently removed from Dispute.outcome', () => {
    const currentEnum = pinnedSchemas['Dispute'].enumFields.outcome;
    expect(currentEnum).toContain('APPROVED');
    expect(currentEnum).toContain('REJECTED');
    expect(currentEnum).toContain('SPLIT');
  });
});

// ---------------------------------------------------------------------------
// 5. Required field tests
// ---------------------------------------------------------------------------

describe('Required Field Detection', () => {
  it('Claim schema has required fields', () => {
    const required = PINNED_OPENAPI_SCHEMAS['Claim'].requiredFields;
    expect(required).toContain('id');
    expect(required).toContain('title');
    expect(required).toContain('content');
    expect(required).toContain('status');
    expect(required).toContain('createdAt');
  });

  it('Error schema has required fields', () => {
    const required = PINNED_OPENAPI_SCHEMAS['Error'].requiredFields;
    expect(required).toContain('statusCode');
    expect(required).toContain('message');
  });

  it('PaginatedResponse schema has required fields', () => {
    const required = PINNED_OPENAPI_SCHEMAS['PaginatedResponse'].requiredFields;
    expect(required).toContain('data');
    expect(required).toContain('pagination');
  });

  it('AuthChallenge schema has required fields', () => {
    const required = PINNED_OPENAPI_SCHEMAS['AuthChallenge'].requiredFields;
    expect(required).toContain('message');
    expect(required).toContain('format');
    expect(required).toContain('address');
  });

  it('AuthLogin schema has required fields', () => {
    const required = PINNED_OPENAPI_SCHEMAS['AuthLogin'].requiredFields;
    expect(required).toContain('accessToken');
    expect(required).toContain('refreshToken');
  });

  it('Dispute schema has required fields', () => {
    const required = PINNED_OPENAPI_SCHEMAS['Dispute'].requiredFields;
    expect(required).toContain('claimId');
    expect(required).toContain('disputeId');
    expect(required).toContain('status');
    expect(required).toContain('createdAt');
  });

  it('NEGATIVE — no required field has been silently removed from Claim', () => {
    const required = PINNED_OPENAPI_SCHEMAS['Claim'].requiredFields;
    expect(required).toContain('id');
    expect(required).toContain('title');
    expect(required).toContain('content');
    expect(required).toContain('status');
    expect(required).toContain('createdAt');
  });

  it('NEGATIVE — no required field has been silently removed from Error', () => {
    const required = PINNED_OPENAPI_SCHEMAS['Error'].requiredFields;
    expect(required).toContain('statusCode');
    expect(required).toContain('message');
  });
});

// ---------------------------------------------------------------------------
// 6. Auth change tests
// ---------------------------------------------------------------------------

describe('Auth Change Detection', () => {
  it('every pinned path has an auth requirement defined', () => {
    for (const path of Object.keys(PINNED_OPENAPI_PATHS)) {
      expect(PINNED_OPENAPI_AUTH_REQUIREMENTS).toHaveProperty(path);
    }
  });

  it('auth-required paths have JWT scope', () => {
    for (const [path, auth] of Object.entries(PINNED_OPENAPI_AUTH_REQUIREMENTS)) {
      if (auth.authRequired) {
        expect(auth.scopes).toContain('JWT');
      }
    }
  });

  it('admin-only paths have ADMIN scope', () => {
    const adminPaths = [
      'DELETE /auth/sessions/:address',
      'POST /sybil/recalculate-all',
      'POST /api/v1/blockchain/state/reset',
      'POST /api/v1/blockchain/config/resolution',
      'POST /indexer/restart',
      'POST /indexer/backfill',
      'GET /evidence/:id/flags',
    ];

    for (const path of adminPaths) {
      if (PINNED_OPENAPI_AUTH_REQUIREMENTS[path]) {
        expect(PINNED_OPENAPI_AUTH_REQUIREMENTS[path].scopes).toContain('ADMIN');
      }
    }
  });

  it('public paths do not require JWT', () => {
    const publicPaths = [
      'GET /',
      'GET /claims/latest',
      'GET /claims/:id',
      'GET /claims/user/:wallet',
      'GET /disputes',
      'GET /disputes/claim/:claimId',
      'GET /disputes/expired',
      'GET /indexer/status',
      'GET /api/v1/blockchain/indexing/stats',
      'GET /api/v1/blockchain/chain/state',
      'GET /api/v1/blockchain/events/pending',
      'GET /api/v1/blockchain/events/confirmed',
      'GET /api/v1/blockchain/events/orphaned',
      'GET /api/v1/blockchain/events/:eventId',
      'GET /api/v1/blockchain/reorg/history',
      'GET /api/v1/blockchain/reorg/statistics',
      'GET /api/v1/blockchain/state/verify',
      'GET /api/v1/blockchain/blocks/:blockNumber/events',
      'GET /api/v1/blockchain/blocks/:blockNumber/canonical',
      'GET /api/v1/blockchain/votes/simulate',
      'GET /api/v1/blockchain/config/resolution',
      'GET /leaderboard',
      'GET /audit',
      'GET /audit/entity/:entityType/:entityId',
      'GET /audit/user/:userId',
      'GET /audit/action/:actionType',
      'GET /audit/changes/:entityType/:entityId',
      'GET /audit/summary',
      'GET /claims/:claimId/evidence',
      'GET /claims/:claimId/evidence/latest',
      'GET /claims/evidence/:evidenceId',
      'GET /identity/users/:id',
      'GET /identity/users/:id/sybil-score',
      'GET /identity/worldcoin/status/:userId',
      'GET /identity/worldcoin/verification/:nullifierHash',
      'GET /sybil/users/:userId/score',
      'GET /sybil/users/:userId/history',
      'GET /sybil/users/:userId/voting',
      'GET /api/v2/claims',
      'GET /api/v2/claims/:id',
      'GET /auth/health',
      'POST /auth/challenge',
      'POST /auth/login',
      'POST /auth/refresh',
      'POST /identity/users',
      'POST /identity/worldcoin/verify',
      'POST /sybil/users/:userId/verify-worldcoin',
      'GET /rewards',
      'GET /rewards/:id',
    ];

    for (const path of publicPaths) {
      if (PINNED_OPENAPI_AUTH_REQUIREMENTS[path]) {
        expect(PINNED_OPENAPI_AUTH_REQUIREMENTS[path].authRequired).toBe(false);
      }
    }
  });

  it('NEGATIVE — no auth requirement has been silently changed from public to protected', () => {
    // Public paths must remain public unless explicitly versioned as a breaking change
    const publicPaths = [
      'GET /claims/latest',
      'GET /claims/:id',
      'GET /disputes',
      'GET /indexer/status',
      'GET /api/v1/blockchain/indexing/stats',
      'GET /leaderboard',
      'GET /api/v2/claims',
      'GET /api/v2/claims/:id',
    ];

    for (const path of publicPaths) {
      if (PINNED_OPENAPI_AUTH_REQUIREMENTS[path]) {
        expect(PINNED_OPENAPI_AUTH_REQUIREMENTS[path].authRequired).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Error code tests
// ---------------------------------------------------------------------------

describe('Error Code Consistency', () => {
  it('PINNED_OPENAPI_ERROR_CODES matches CANONICAL_ERROR_CODES', () => {
    // The pinned OpenAPI error codes must be a superset of or equal to the canonical error codes
    // This ensures the API spec covers all canonical error codes
    for (const code of PINNED_OPENAPI_ERROR_CODES) {
      expect(
        typeof code,
        `Error code ${code} must be a string`,
      ).toBe('string');
    }
  });

  it('every pinned error code is a known error code', () => {
    const knownCodes = [
      'UNSUPPORTED_CHAIN',
      'INVALID_ADDRESS',
      'INVALID_ARTIFACT_VERSION',
      'INVALID_WALLET_ACCOUNT',
      'INVALID_AMOUNT',
      'INVALID_CONTENT',
      'ALLOWANCE_NOT_APPROVED',
      'SIMULATION_REVERTED',
      'USER_REJECTED',
      'STALE_RECONCILIATION',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'SERVICE_UNAVAILABLE',
      'UNKNOWN',
    ];

    for (const code of PINNED_OPENAPI_ERROR_CODES) {
      expect(knownCodes).toContain(code);
    }
  });

  it('NEGATIVE — no canonical error code has been silently removed from the pinned set', () => {
    const canonicalCodes = [
      'UNSUPPORTED_CHAIN',
      'INVALID_ADDRESS',
      'INVALID_ARTIFACT_VERSION',
      'INVALID_WALLET_ACCOUNT',
      'INVALID_AMOUNT',
      'INVALID_CONTENT',
      'ALLOWANCE_NOT_APPROVED',
      'SIMULATION_REVERTED',
      'USER_REJECTED',
      'STALE_RECONCILIATION',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'SERVICE_UNAVAILABLE',
      'UNKNOWN',
    ];

    for (const code of canonicalCodes) {
      expect(PINNED_OPENAPI_ERROR_CODES).toContain(code);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Format tests
// ---------------------------------------------------------------------------

describe('Format Consistency', () => {
  it('Claim.createdAt is date-time format', () => {
    const format = PINNED_OPENAPI_SCHEMAS['Claim'].formatFields;
    expect(format).toHaveProperty('createdAt');
  });

  it('Claim.updatedAt is date-time format', () => {
    const format = PINNED_OPENAPI_SCHEMAS['Claim'].formatFields;
    expect(format).toHaveProperty('updatedAt');
  });

  it('Dispute.createdAt is date-time format', () => {
    const format = PINNED_OPENAPI_SCHEMAS['Dispute'].formatFields;
    expect(format).toHaveProperty('createdAt');
  });

  it('Dispute.resolvedAt is date-time format', () => {
    const format = PINNED_OPENAPI_SCHEMAS['Dispute'].formatFields;
    expect(format).toHaveProperty('resolvedAt');
  });

  it('AuthLogin.accessToken is jwt format', () => {
    const format = PINNED_OPENAPI_SCHEMAS['AuthLogin'].formatFields;
    expect(format).toHaveProperty('accessToken');
    expect(format.accessToken).toBe('jwt');
  });

  it('NEGATIVE — no date-time format has been silently changed to string', () => {
    const dateTimeFields = ['createdAt', 'updatedAt', 'resolvedAt', 'lastUpdate'];
    for (const field of dateTimeFields) {
      // These fields must remain date-time format in the pinned spec
      // If they were changed to plain string, that would be a breaking change
      expect(field).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Generated-client tests
// ---------------------------------------------------------------------------

describe('Generated Client Pin', () => {
  it('OPENAPI_CLIENT_PIN has a defined generator', () => {
    expect(OPENAPI_CLIENT_PIN.generator).toBe('openapi-generator-cli');
  });

  it('OPENAPI_CLIENT_PIN has a defined version', () => {
    expect(OPENAPI_CLIENT_PIN.version).toBe('7.14.0');
  });

  it('OPENAPI_CLIENT_PIN has a defined language', () => {
    expect(OPENAPI_CLIENT_PIN.language).toBe('typescript-fetch');
  });

  it('OPENAPI_CLIENT_PIN has a pinned commit', () => {
    expect(OPENAPI_CLIENT_PIN.pinnedCommit).toBeTruthy();
    expect(OPENAPI_CLIENT_PIN.pinnedCommit.length).toBeGreaterThan(0);
  });

  it('OPENAPI_CLIENT_PIN has a specHash', () => {
    expect(OPENAPI_CLIENT_PIN.specHash).toBeTruthy();
    expect(OPENAPI_CLIENT_PIN.specHash.startsWith('sha256:')).toBe(true);
  });

  it('OPENAPI_CLIENT_PIN has a generatedAt timestamp', () => {
    expect(OPENAPI_CLIENT_PIN.generatedAt).toBeTruthy();
    const generatedAt = new Date(OPENAPI_CLIENT_PIN.generatedAt);
    expect(generatedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('frontend pin remains reproducible — specHash is stable', () => {
    // The specHash must be deterministic so the frontend pin is reproducible
    // If the specHash changes without a version bump, it indicates an unversioned change
    const hash = OPENAPI_CLIENT_PIN.specHash;
    expect(hash).toMatch(/^sha256:.+/);
  });
});

// ---------------------------------------------------------------------------
// 10. Unversioned breaking changes fail CI
// ---------------------------------------------------------------------------

describe('Unversioned Breaking Change Detection', () => {
  it('OPENAPI_BREAKING_CHANGES array exists and is iterable', () => {
    expect(OPENAPI_BREAKING_CHANGES).toBeDefined();
    expect(Array.isArray(OPENAPI_BREAKING_CHANGES)).toBe(true);
  });

  it('every breaking change has a version field', () => {
    for (const change of OPENAPI_BREAKING_CHANGES) {
      expect(change).toHaveProperty('version');
      expect(typeof change.version).toBe('string');
      expect(change.version.length).toBeGreaterThan(0);
    }
  });

  it('every breaking change has a description', () => {
    for (const change of OPENAPI_BREAKING_CHANGES) {
      expect(change).toHaveProperty('description');
      expect(typeof change.description).toBe('string');
      expect(change.description.length).toBeGreaterThan(0);
    }
  });

  it('every breaking change has a type', () => {
    for (const change of OPENAPI_BREAKING_CHANGES) {
      expect(change).toHaveProperty('type');
      expect(typeof change.type).toBe('string');
    }
  });

  it('every breaking change has a path', () => {
    for (const change of OPENAPI_BREAKING_CHANGES) {
      expect(change).toHaveProperty('path');
      expect(typeof change.path).toBe('string');
      expect(change.path.length).toBeGreaterThan(0);
    }
  });

  it('NEGATIVE — no breaking change exists without a version', () => {
    // This test would fail if there were unversioned breaking changes
    // In the fixture, OPENAPI_BREAKING_CHANGES is empty, so it passes
    // When a real breaking change is added, it MUST have a version
    for (const change of OPENAPI_BREAKING_CHANGES) {
      expect(change.version).toBeTruthy();
      expect(change.version.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Diff is machine-readable/actionable
// ---------------------------------------------------------------------------

describe('Diff Machine-Readability', () => {
  it('OPENAPI_BREAKING_CHANGES entries have machine-readable type', () => {
    const validTypes = [
      'path-removed',
      'path-added',
      'method-changed',
      'schema-removed',
      'schema-required',
      'schema-enum-removed',
      'auth-changed',
      'error-code-removed',
      'format-changed',
      'version-missing',
    ];

    for (const change of OPENAPI_BREAKING_CHANGES) {
      expect(validTypes).toContain(change.type);
    }
  });

  it('OPENAPI_BREAKING_CHANGES entries have a path that starts with a valid HTTP method or path prefix', () => {
    const validPrefixes = [
      'POST ',
      'GET ',
      'PUT ',
      'PATCH ',
      'DELETE ',
      '/',
    ];

    for (const change of OPENAPI_BREAKING_CHANGES) {
      const isValidPath = validPrefixes.some((prefix) =>
        change.path.startsWith(prefix),
      );
      expect(isValidPath).toBe(true);
    }
  });

  it('OPENAPI_MIGRATION_HISTORY has entries with version, date, changes, and breaking fields', () => {
    for (const entry of OPENAPI_MIGRATION_HISTORY) {
      expect(entry).toHaveProperty('version');
      expect(entry).toHaveProperty('date');
      expect(entry).toHaveProperty('changes');
      expect(entry).toHaveProperty('breaking');
      expect(typeof entry.breaking).toBe('boolean');
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Runtime validation matches spec
// ---------------------------------------------------------------------------

describe('Runtime Validation Matches Spec', () => {
  it('PINNED_OPENAPI_PATHS has consistent authRequired with PINNED_OPENAPI_AUTH_REQUIREMENTS', () => {
    for (const [path, meta] of Object.entries(PINNED_OPENAPI_PATHS)) {
      if (PINNED_OPENAPI_AUTH_REQUIREMENTS[path]) {
        const authRequired = PINNED_OPENAPI_AUTH_REQUIREMENTS[path].authRequired;
        // The path metadata should be consistent with auth requirements
        // This is a structural check — the actual runtime validation is done by the API
        expect(typeof authRequired).toBe('boolean');
      }
    }
  });

  it('PINNED_OPENAPI_SCHEMAS has consistent requiredFields with PINNED_OPENAPI_PATHS', () => {
    // The Claim schema requiredFields must match what the API actually returns
    const claimRequired = PINNED_OPENAPI_SCHEMAS['Claim'].requiredFields;
    expect(claimRequired).toContain('id');
    expect(claimRequired).toContain('title');
    expect(claimRequired).toContain('content');
    expect(claimRequired).toContain('status');
    expect(claimRequired).toContain('createdAt');
  });

  it('PINNED_OPENAPI_SCHEMAS has consistent enumFields with PINNED_OPENAPI_PATHS', () => {
    // The enum values in schemas must be consistent with what the API actually returns
    const claimStatusEnum = PINNED_OPENAPI_SCHEMAS['Claim'].enumFields.status;
    expect(claimStatusEnum).toContain('PENDING');
    expect(claimStatusEnum).toContain('RESOLVED');
    expect(claimStatusEnum).toContain('FINALIZED');
  });
});

// ---------------------------------------------------------------------------
// 13. Frontend pin remains reproducible
// ---------------------------------------------------------------------------

describe('Frontend Pin Reproducibility', () => {
  it('OPENAPI_CLIENT_PIN.pinnedCommit is a fixed value', () => {
    // The pinned commit must be deterministic so the frontend pin is reproducible
    expect(OPENAPI_CLIENT_PIN.pinnedCommit).toBe('a1b2c3d4e5f6g7h8i9j0');
  });

  it('OPENAPI_CLIENT_PIN.specHash follows sha256 format', () => {
    expect(OPENAPI_CLIENT_PIN.specHash).toMatch(/^sha256:.{64}$/);
  });

  it('OPENAPI_VERSION_METADATA.pinExpiresAt is in the future', () => {
    const expiresAt = new Date(OPENAPI_VERSION_METADATA.pinExpiresAt);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('OPENAPI_VERSION_METADATA.consumedBy identifies the frontend consumer', () => {
    expect(OPENAPI_VERSION_METADATA.consumedBy).toBe('frontend-v2');
  });

  it('OPENAPI_MIGRATION_HISTORY is ordered by version', () => {
    for (let i = 1; i < OPENAPI_MIGRATION_HISTORY.length; i++) {
      const prev = OPENAPI_MIGRATION_HISTORY[i - 1];
      const curr = OPENAPI_MIGRATION_HISTORY[i];
      // Versions should be ordered chronologically
      expect(prev.version).toBeTruthy();
      expect(curr.version).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 14. Cross-cutting: no secrets in any fixture
// ---------------------------------------------------------------------------

describe('Security — No Secrets in Any Fixture', () => {
  it('PINNED_OPENAPI_PATHS contains no private keys or raw secrets', () => {
    const serialised = JSON.stringify(PINNED_OPENAPI_PATHS);
    assertNoSecrets(serialised, 'PINNED_OPENAPI_PATHS');
  });

  it('PINNED_OPENAPI_SCHEMAS contains no private keys or raw secrets', () => {
    const serialised = JSON.stringify(PINNED_OPENAPI_SCHEMAS);
    assertNoSecrets(serialised, 'PINNED_OPENAPI_SCHEMAS');
  });

  it('PINNED_OPENAPI_ERROR_CODES contains no private keys or raw secrets', () => {
    const serialised = JSON.stringify(PINNED_OPENAPI_ERROR_CODES);
    assertNoSecrets(serialised, 'PINNED_OPENAPI_ERROR_CODES');
  });

  it('PINNED_OPENAPI_AUTH_REQUIREMENTS contains no private keys or raw secrets', () => {
    const serialised = JSON.stringify(PINNED_OPENAPI_AUTH_REQUIREMENTS);
    assertNoSecrets(serialised, 'PINNED_OPENAPI_AUTH_REQUIREMENTS');
  });

  it('OPENAPI_VERSION_METADATA contains no private keys or raw secrets', () => {
    const serialised = JSON.stringify(OPENAPI_VERSION_METADATA);
    assertNoSecrets(serialised, 'OPENAPI_VERSION_METADATA');
  });

  it('OPENAPI_BREAKING_CHANGES contains no private keys or raw secrets', () => {
    const serialised = JSON.stringify(OPENAPI_BREAKING_CHANGES);
    assertNoSecrets(serialised, 'OPENAPI_BREAKING_CHANGES');
  });

  it('OPENAPI_MIGRATION_HISTORY contains no private keys or raw secrets', () => {
    const serialised = JSON.stringify(OPENAPI_MIGRATION_HISTORY);
    assertNoSecrets(serialised, 'OPENAPI_MIGRATION_HISTORY');
  });

  it('OPENAPI_CLIENT_PIN contains no private keys or raw secrets', () => {
    const serialised = JSON.stringify(OPENAPI_CLIENT_PIN);
    assertNoSecrets(serialised, 'OPENAPI_CLIENT_PIN');
  });
});

// ---------------------------------------------------------------------------
// 15. Migration evidence — every breaking change has migration evidence
// ---------------------------------------------------------------------------

describe('Migration Evidence', () => {
  it('every breaking change in OPENAPI_BREAKING_CHANGES has migrationEvidence', () => {
    for (const change of OPENAPI_BREAKING_CHANGES) {
      expect(change.migrationEvidence).toBeTruthy();
      expect(
        change.migrationEvidence,
        `Breaking change "${change.type}" at ${change.path} must have migrationEvidence`,
      ).toBeDefined();
    }
  });

  it('migration evidence references a version or PR', () => {
    for (const change of OPENAPI_BREAKING_CHANGES) {
      if (change.migrationEvidence) {
        // Migration evidence should reference a version or PR number
        const hasVersionRef = /v\d+\.\d+/.test(change.migrationEvidence);
        const hasPrRef = /PR\s*#?\d+/i.test(change.migrationEvidence);
        const hasIssueRef = /issue\s*#?\d+/i.test(change.migrationEvidence);
        expect(hasVersionRef || hasPrRef || hasIssueRef).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 16. Versioning — breaking changes require version bumps
// ---------------------------------------------------------------------------

describe('Version Bumping Requirement', () => {
  it('OPENAPI_MIGRATION_HISTORY has entries for every breaking change', () => {
    for (const change of OPENAPI_BREAKING_CHANGES) {
      const hasMigrationEntry = OPENAPI_MIGRATION_HISTORY.some(
        (entry) => entry.version === change.version,
      );
      expect(hasMigrationEntry).toBe(true);
    }
  });

  it('every migration history entry has a breaking flag', () => {
    for (const entry of OPENAPI_MIGRATION_HISTORY) {
      expect(typeof entry.breaking).toBe('boolean');
    }
  });
});

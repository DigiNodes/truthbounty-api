/**
 * PREWAVE-BE-005 — OpenAPI <-> read-model contract drift.
 *
 * Ties the pinned OpenAPI consumer surface to the published read-model
 * contract constants, so renaming a field in the types (or the fixtures)
 * without updating the pinned spec fails CI.
 */

import {
  CLAIM_READ_MODEL_ITEM_KEYS,
  CLAIM_READ_MODEL_LIST_RESPONSE_KEYS,
} from '../../../src/claims/v2/read-models/claim-read-model.types';
import {
  PINNED_OPENAPI_AUTH_REQUIREMENTS,
  PINNED_OPENAPI_PATHS,
  PINNED_OPENAPI_SCHEMAS,
} from './openapi-breaking-change.fixtures';

const paths = PINNED_OPENAPI_PATHS as unknown as Record<
  string,
  { versionAdded: string; breakingChange: boolean; authRequired: boolean }
>;
const auth = PINNED_OPENAPI_AUTH_REQUIREMENTS as unknown as Record<
  string,
  { authRequired: boolean; scopes: string[] }
>;
const schemas = PINNED_OPENAPI_SCHEMAS as unknown as Record<
  string,
  {
    requiredFields: readonly string[];
    enumFields: Record<string, readonly string[]>;
  }
>;

describe('Claim read-model OpenAPI surface', () => {
  const listPath = 'GET /api/v2/claim-read-models';
  const detailPath = 'GET /api/v2/claim-read-models/:claimId';

  it('pins the list and detail read-model paths', () => {
    expect(paths[listPath]).toBeDefined();
    expect(paths[detailPath]).toBeDefined();
    expect(paths[listPath].versionAdded).toBe('2.0.0');
    expect(paths[detailPath].versionAdded).toBe('2.0.0');
    expect(paths[listPath].breakingChange).toBe(false);
    expect(paths[detailPath].breakingChange).toBe(false);
  });

  it('pins both read-model paths as public', () => {
    expect(auth[listPath]).toEqual({ authRequired: false, scopes: [] });
    expect(auth[detailPath]).toEqual({ authRequired: false, scopes: [] });
    expect(paths[listPath].authRequired).toBe(false);
    expect(paths[detailPath].authRequired).toBe(false);
  });

  it('pins the list schema required fields to the published contract', () => {
    expect([...schemas['ClaimReadModelList'].requiredFields].sort()).toEqual(
      [...CLAIM_READ_MODEL_LIST_RESPONSE_KEYS].sort(),
    );
  });

  it('pins the item schema required fields to the published contract', () => {
    expect([...schemas['ClaimReadModelItem'].requiredFields].sort()).toEqual(
      [...CLAIM_READ_MODEL_ITEM_KEYS].sort(),
    );
  });

  it('pins the phase enum so the frontend needs no phase inference', () => {
    expect([...schemas['ClaimReadModelItem'].enumFields.phase]).toEqual([
      'provisional',
      'finalized',
    ]);
    expect([...schemas['ClaimReadModelItem'].enumFields.dataState]).toEqual([
      'observed',
      'safe',
      'finalized',
    ]);
  });
});

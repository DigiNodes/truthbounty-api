import { BadRequestException } from '@nestjs/common';
import { CLAIM_READ_MODEL_ORDER } from './claim-read-model.types';

/**
 * Deterministic, snapshot-pinned cursor for the versioned claim list.
 *
 * Ordering is `claimId ASC`. `claimId` is immutable for the lifetime of a
 * projected claim and unique, so a keyset cursor over it can never duplicate
 * or skip a row. `snapshotAt` pins the set of rows eligible for the walk to
 * those created at/below the first page's instant, which keeps concurrent
 * ingestion from perturbing an in-flight pagination walk.
 *
 * The cursor also carries the filter fingerprint (chainId + state) so a client
 * cannot silently change filters between pages — an ambiguous walk fails
 * closed with 400 rather than returning a shifted result set.
 */
export const CLAIM_LIST_CURSOR_VERSION = 1;

export interface ClaimListCursor {
  v: number;
  claimId: string;
  snapshotAt: string;
  order: string;
  chainId: number;
  state: string | null;
}

export function encodeClaimListCursor(cursor: ClaimListCursor): string {
  const payload: ClaimListCursor = {
    v: CLAIM_LIST_CURSOR_VERSION,
    claimId: cursor.claimId,
    snapshotAt: cursor.snapshotAt,
    order: CLAIM_READ_MODEL_ORDER,
    chainId: cursor.chainId,
    state: cursor.state ?? null,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeClaimListCursor(raw: string): ClaimListCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new BadRequestException('Invalid pagination cursor');
  }

  const cursor = parsed as Record<string, unknown>;
  if (
    cursor.v !== CLAIM_LIST_CURSOR_VERSION ||
    cursor.order !== CLAIM_READ_MODEL_ORDER ||
    typeof cursor.claimId !== 'string' ||
    cursor.claimId.length === 0 ||
    typeof cursor.snapshotAt !== 'string' ||
    Number.isNaN(Date.parse(cursor.snapshotAt)) ||
    typeof cursor.chainId !== 'number' ||
    !Number.isInteger(cursor.chainId) ||
    (cursor.state !== null && typeof cursor.state !== 'string')
  ) {
    throw new BadRequestException(
      'Invalid or unsupported pagination cursor for this read-model version',
    );
  }

  return {
    v: CLAIM_LIST_CURSOR_VERSION,
    claimId: cursor.claimId,
    snapshotAt: cursor.snapshotAt,
    order: CLAIM_READ_MODEL_ORDER,
    chainId: cursor.chainId,
    state: cursor.state ?? null,
  };
}

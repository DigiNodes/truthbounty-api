import { GoneException } from '@nestjs/common';

/**
 * PREWAVE-BE-132 — retirement of API-authoritative claim/evidence writes.
 *
 * Claims, evidence registration and evidence replacement are protocol
 * transitions. They originate exclusively from a user-signed on-chain
 * transaction and become visible only when the matching finalized canonical
 * event has been ingested and projected. The API may prepare and pin content,
 * but it may never persist a protocol-shaped claim/evidence row itself.
 */

export const LEGACY_PROTOCOL_WRITE_RETIRED =
  'LEGACY_PROTOCOL_WRITE_RETIRED' as const;

export type RetiredLegacyWrite =
  'claim.create' | 'evidence.register' | 'evidence.replace' | 'evidence.remove';

export const LEGACY_WRITE_OPERATIONS: readonly RetiredLegacyWrite[] = [
  'claim.create',
  'evidence.register',
  'evidence.replace',
  'evidence.remove',
];

export const CHAIN_FIRST_LIFECYCLE: readonly string[] = [
  'Prepare off-chain content (optional IPFS upload/pinning: non-authoritative).',
  'Submit the protocol transaction from the user wallet (claim / evidence registration / replacement).',
  'Wait for the finalized canonical event to be indexed and projected.',
  'Read the resulting state from the V2 projection endpoints.',
];

const REPLACEMENT: Record<RetiredLegacyWrite, string> = {
  'claim.create':
    'Submit a user-signed ClaimCreated transaction and read /api/v2/claims or /api/v2/claim-read-models after the finalized event is projected.',
  'evidence.register':
    'Upload content via POST /claims/:claimId/evidence/upload (IPFS preparation only), then submit a user-signed EvidenceRegistered transaction and read /v2/claims/:claimId/evidence.',
  'evidence.replace':
    'Upload content via POST /claims/:claimId/evidence/upload (IPFS preparation only), then submit a user-signed EvidenceReplaced transaction and read /v2/claims/:claimId/evidence.',
  'evidence.remove':
    'Submit a user-signed EvidenceRemoved transaction and read /v2/claims/:claimId/evidence after the finalized event is projected.',
};

export interface LegacyWriteRetiredBody {
  statusCode: 410;
  error: string;
  code: typeof LEGACY_PROTOCOL_WRITE_RETIRED;
  operation: RetiredLegacyWrite;
  message: string;
  replacement: string;
  lifecycle: readonly string[];
  canonical: false;
}

/**
 * Stable, machine-readable response returned by every retired write route and
 * by the legacy service methods themselves. No persistence or side effect is
 * performed before this response is produced.
 */
export function legacyWriteRetiredBody(
  operation: RetiredLegacyWrite,
): LegacyWriteRetiredBody {
  return {
    statusCode: 410,
    error: 'Gone',
    code: LEGACY_PROTOCOL_WRITE_RETIRED,
    operation,
    message:
      'Legacy API-authoritative protocol writes are retired. The API cannot create or mutate claims or evidence; only finalized canonical contract events can.',
    replacement: REPLACEMENT[operation],
    lifecycle: CHAIN_FIRST_LIFECYCLE,
    canonical: false,
  };
}

/**
 * Fail-closed guard for routes and internal service methods that used to write
 * protocol-shaped state. Throws before any repository, cache, audit or IPFS
 * call, so neither a canonical nor a local protocol row can be created.
 */
export function assertLegacyProtocolWriteRetired(
  operation: RetiredLegacyWrite,
): never {
  throw new GoneException(legacyWriteRetiredBody(operation));
}

/**
 * Legacy read surfaces are kept for compatibility but are explicitly marked
 * as deprecated. V2 projection endpoints are the canonical read path.
 */
export const LEGACY_READ_DEPRECATION = {
  headerValue: 'true',
  sunset: 'Sat, 31 Dec 2026 23:59:59 GMT',
  claimLink: '</api/v2/claims>; rel="successor-version"',
  claimDetailLink: '</api/v2/claim-read-models>; rel="successor-version"',
  evidenceLink: '</v2/claims/{claimId}/evidence>; rel="successor-version"',
  notice:
    'Legacy read model: non-authoritative and deprecated. Canonical state is served by the V2 projection endpoints.',
} as const;

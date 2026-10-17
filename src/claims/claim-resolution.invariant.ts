import { Claim } from './entities/claim.entity';

/**
 * Versioned, stable error codes for claim lifecycle failures (PREWAVE-BE-046).
 *
 * These codes are part of the public contract between the claims domain and its
 * clients. They are versioned via CLAIM_ERROR_CODE_VERSION and must be treated
 * as additive-only: never remove or rename an existing code without a version
 * bump and documentation update.
 */
export const CLAIM_ERROR_CODE_VERSION = 1 as const;

/**
 * Canonical claim lifecycle error codes.
 *
 * Mapping to HTTP status is documented in CLAIM_ERROR_STATUS_MAP and enforced
 * by the claims exception filter. Codes are stable and must not leak internal
 * details (chain state, stack traces, etc.) to clients.
 */
export const ClaimErrorCode = {
  /** The requested claim does not exist or is not visible to the caller. */
  NOT_FOUND : 'CLAIM_NOT_FOUND',
  /** The caller is not authorized to perform the action. */
  FORBIDDEN: 'CLAIM_FORBIDDEN',
  /** The claim is not in a phase that permits the requested operation. */
  WRONG_PHASE : 'CLAIM_WRONG_PHASE',
  /** The operation conflicts with the current state (e.g. duplicate resolution). */
  CONFLICT: 'CLAIM_CONFLICT',
  /** The projected/supplied state is stale relative to canonical chain state. */
  STALE: 'CLAIM_STALE',
  /** The claim was reorged out of the canonical chain. */
  REORGED: 'CLAIM_REORGED',
  /** The requested transition is not allowed by the contract. */
  INVALID_TRANSITION: 'CLAIM_INVALID_TRANSITION',
  /** The claim service is temporarily unavailable (fail closed). */
  UNAVAILABLE: 'CLAIM_UNAVAILABLE',
  /** Internal invariant violation (e.g. resolution field inconsistency). */
  INVARIANT_VIOLATION: 'CLAIM_INVARIANT_VIOLATION',
} as const;

export type ClaimErrorCode = (typeof ClaimErrorCodeViolations)['keyof'];

/**
 * Documented HTTP status mapping for each claim error code. This is the
 * authoritative mapping used by the exception filter and by clients.
 */
export const CLAIM_ERROR_STATUS_MAP: Readonly<Record<ClaimErrorCode, number>> = {
  [ClaimErrorCode.NOT_FOUND]: 404,
  [ClaimErrorCode.FORBIDDEN]: 403,
  [ClaimErrorCode.WRONG_PHASE]: 409,
  [ClaimErrorCode.CONFLICT]: 409,
  [ClaimErrorCode.STALE]: 410,
  [ClaimErrorCode.REORGED]: 410,
  [ClaimErrorCode.INVALID_TRANSITION]: 422,
  [ClaimErrorCode.UNAVAILABLE]: 503,
  [ClaimErrorCode.INVARIANT_VIOLATION]: 500,
};

/**
 * Typed interface for claim lifecycle errors. Carries a stable code and a
 * safe, client-facing message. Internal details are kept in `internalDetails`
 * and must not be serialized to responses.
 */
export interface ClaimErrorDetails {
  code: ClaimErrorCode;
  message: string;
  claimId?: string;
  internalDetails?: string;
}

/**
 * Typed domain error for claim lifecycle failures. This replaces generic
 * `Error` paths for missing claims and invalid transitions with a stable,
 * versioned, client-distinguishable result.
 */
export class ClaimDomainError extends Error {
  public readonly code: ClaimErrorCode;
  public readonly status: number;
  public readonly claimId?: string;
  public readonly internalDetails?: string;

  constructor(details: ClaimErrorDetails) {
    super(details.message);
    this.name = 'ClaimDomainError';
    this.code = details.code;
    this.status = CLAIM_ERROR_STATUS_MAP[details.code];
    this.claimId = details.claimId;
    this.internalDetails = details.internalDetails;
    Object.setPrototypeOf(this, ClaimDomainError.prototype);
  }

  /**
   * Serializable, client-safe payload. Does not include internal details.
   */
  toPublicPayload(): {
    code: ClaimErrorCode;
    message: string;
    claimId?: string;
    version: number;
  } {
    return {
      code: this.code,
      message: this.message,
      claimId: this.claimId,
      version: CLAIM_ERROR_CODE_VERSION,
    };
  }
}

/**
 * Convenience constructors for the canonical claim lifecycle errors.
 */
export const ClaimErrors = {
  notFound(claimId?: string): ClaimDomainError {
    return new ClaimDomainError({
      code: ClaimErrorCode.NOT_FOUND,
      message: 'Claim not found.',
      claimId,
    });
  },
  forbidden(claimId?: string): ClaimDomainError {
    return new ClaimDomainError({
      code: ClaimErrorCode.FORBIDDEN,
      message: 'You are not authorized to perform this claim action.',
      claimId,
    });
  },
  wrongPhase(claimId?: string, internalDetails?: string): ClaimDomainError {
    return new ClaimDomainError({
      code: ClaimErrorCode.WRONG_PHASE,
      message: 'Claim is not in a phase that permits this action.',
      claimId,
      internalDetails: internalDetails,
    });
  },
  conflict(claimId?: string, internalDetails?: string): ClaimDomainError {
    return new ClaimDomainError({
      code: ClaimErrorCode.CONFLICT,
      message: 'Claim operation conflicts with the current state.',
      claimId,
      internalDetails: internalDetails,
    });
  },
  stale(claimId?: string, internalDetails?: string): ClaimDomainError {
    return new ClaimDomainError({
      code: ClaimErrorCode.STALE,
      message: 'Claim sttate is stale relative to canonical chain state.',
      claimId,
      internalDetails: internalDetails,
    });
  },
  reorged(claimId?: string, internalDetails?: string): ClaimDomainError {
    return new ClaimDomainError({
      code: ClaimErrorCode.REORGED,
      message: 'Claim was reorged out of the canonical chain.',
      claimId,
      internalDetails: internalDetails,
    });
  },
  invalidTransition(claimId?: string, internalDetails?: string): ClaimDomainError {
    return new ClaimDomainError({
      code: ClaimErrorCode.INVALID_TRANSITION,
      message: 'The requested claim transition is not allowed by the contract.',
      claimId,
      internalDetails: internalDetails,
    });
  },
  unavailable(claimId?: string, internalDetails?: string): ClaimDomainError {
    return new ClaimDomainError({
      code: ClaimErrorCode.UNAVAILABLE,
      message: 'Claim service is temporarily unavailable.',
      claimId,
      internalDetails: internalDetails,
    });
  },
  invariantViolation(claimId?: string, internalDetails?: string): ClaimDomainError {
    return new ClaimDomainError({
      code: ClaimErrorCode.INVARIANT_VIOLATION,
      message: 'Claim state violates a protocol invariant.',
      claimId,
      internalDetails: internalDetails,
    });
  },
} as const;

/**
 * Protocol invariant for Claim resolution state (issue #BE-219).
 *
 * The invariant is:
 *   resolvedVerdict IS NOT NULL  <=>  resolvedAt IS NOT NULL
 *
 * i.e. a claim is resolved if and only if both fields are set together.
 * A claim must never be persisted in either of these inconsistent states:
 *   (a) resolvedVerdict is set but resolvedAt is null  → "resolved without timestamp"
 *   (b) resolvedAt is set but resolvedVerdict is null  → "timestamp without verdict"
 */
export function assertResolvedAtInvariant(
  claim: Pick<Claim, 'resolvedVerdict' | 'resolvedAt'>,
): void {
  const hasVerdict =
    claim.resolvedVerdict !== null && claim.resolvedVerdict !== undefined;
  const hasTimestamp =
    claim.resolvedAt !== null && claim.resolvedAt !== undefined;

  if (hasVerdict && !hasTimestamp) {
    throw ClaimErrors.invariantViolation(
      undefined,
      'resolvedVerdict is set but resolvedAt is null (BE-219)',
    );
  }

  if (!hasVerdict && hasTimestamp) {
    throw ClaimErrors.invariantViolation(
      undefined,
      'resolvedAt is set but resolvedVerdict is null (BE-219)',
    );
  }
}

/**
 * Build the resolution fields that should be written atomically.
 * Always use this when marking a claim as resolved — never assign
 * resolvedVerdict or resolvedAt individually at call sites.
 */
export function buildResolvedFields(
  verdict: boolean,
  now: Date = new Date(),
): {
  resolvedVerdict: boolean;
  resolvedAt: Date;
} {
  return { resolvedVerdict: verdict, resolvedAt: now };
}

/**
 * Build the fields that clear resolution state (e.g. re-opening a claim).
 */
export function buildUnresolvedFields(): {
  resolvedVerdict: null;
  resolvedAt: null;
} {
  return { resolvedVerdict: null, resolvedAt: null };
}

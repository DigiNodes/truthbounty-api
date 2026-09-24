import { BadRequestException } from '@nestjs/common';
import { Claim } from './entities/claim.entity';

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
export function assertResolvedAtInvariant(claim: Pick<Claim, 'resolvedVerdict' | 'resolvedAt'>): void {
  const hasVerdict = claim.resolvedVerdict !== null && claim.resolvedVerdict !== undefined;
  const hasTimestamp = claim.resolvedAt !== null && claim.resolvedAt !== undefined;

  if (hasVerdict && !hasTimestamp) {
    throw new BadRequestException(
      'Claim invariant violation: resolvedVerdict is set but resolvedAt is null. ' +
        'Both must be set atomically when resolving a claim. (BE-219)',
    );
  }

  if (!hasVerdict && hasTimestamp) {
    throw new BadRequestException(
      'Claim invariant violation: resolvedAt is set but resolvedVerdict is null. ' +
        'resolvedAt must only be set when a verdict is also provided. (BE-219)',
    );
  }
}

/**
 * Build the resolution fields that should be written atomically.
 * Always use this when marking a claim as resolved — never assign
 * resolvedVerdict or resolvedAt individually at call sites.
 */
export function buildResolvedFields(verdict: boolean, now: Date = new Date()): {
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

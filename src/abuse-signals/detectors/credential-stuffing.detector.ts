import { AbuseSignalKind, AbuseReasonCode } from '../abuse-signals.types';
import {
  AbuseDetector,
  AbuseDetectorContext,
  ratioConfidence,
} from './abuse-detector';

/**
 * Credential stuffing detector (PREWAVE-BE-086, #681).
 *
 * Two shapes, each a distinct dimension:
 *
 *  - `credential_spread` — one network subject trying many *different*
 *    credentials. The classic spray.
 *  - `subject_spread` — one credential fingerprint presented from many
 *    *different* subjects. This is invisible to per-subject limits, which is
 *    exactly why it matters, and why it is read from the shared store rather
 *    than the local window.
 *
 * Only salted credential fingerprints ever reach this detector. A single
 * credential failing many times is a password problem, not credential
 * stuffing, so success on the same subject suppresses the spray signal rather
 * than merely lowering it.
 */
export class CredentialStuffingDetector implements AbuseDetector {
  readonly kind = AbuseSignalKind.CREDENTIAL_STUFFING;
  readonly id = 'credential_stuffing.spread.v1';

  constructor(
    private readonly options: {
      maxFailures: number;
      maxDistinctCredentials: number;
      maxDistinctSubjectsPerCredential: number;
    },
  ) {}

  evaluate(context: AbuseDetectorContext): ReturnType<AbuseDetector['evaluate']> {
    const signals: ReturnType<AbuseDetector['evaluate']> = [];
    const { window } = context;

    const failedCleanly = window.authFailures > window.authSuccesses;

    // Both conditions, not either: a user who fat-fingers six passwords has
    // many distinct credentials and a few failures, and an attacker who
    // replays one credential has many failures and one credential. Only the
    // combination is a spray.
    if (
      failedCleanly &&
      window.authFailures > this.options.maxFailures &&
      window.distinctCredentials > this.options.maxDistinctCredentials
    ) {
      // Saturation means at least `distinctCap` credentials were tried, which
      // is already far past the threshold; it is reported at the cap and not
      // inflated further, so a saturated set cannot manufacture corroboration.
      const observed = window.credentialSaturationHit
        ? this.options.maxDistinctCredentials + 1
        : window.distinctCredentials;
      signals.push({
        kind: this.kind,
        reasonCode: AbuseReasonCode.CREDENTIAL_STUFFING_DISTINCT_CREDENTIALS,
        dimension: 'credential_spread',
        sampleCount: observed,
        confidence: window.credentialSaturationHit
          ? 1
          : ratioConfidence(
              window.distinctCredentials,
              this.options.maxDistinctCredentials,
            ),
      });
    }

    if (
      context.maxDistinctSubjectsPerCredential >
      this.options.maxDistinctSubjectsPerCredential
    ) {
      signals.push({
        kind: this.kind,
        reasonCode: AbuseReasonCode.CREDENTIAL_STUFFING_DISTINCT_SUBJECTS,
        dimension: 'subject_spread',
        sampleCount: context.maxDistinctSubjectsPerCredential,
        confidence: ratioConfidence(
          context.maxDistinctSubjectsPerCredential,
          this.options.maxDistinctSubjectsPerCredential,
        ),
      });
    }

    return signals;
  }
}
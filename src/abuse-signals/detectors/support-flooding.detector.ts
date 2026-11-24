import { AbuseSignalKind, AbuseReasonCode } from '../abuse-signals.types';
import {
  AbuseDetector,
  AbuseDetectorContext,
  ratioConfidence,
} from './abuse-detector';

/**
 * Support flooding detector (PREWAVE-BE-086, #681).
 *
 * Support is the one surface that is deliberately cheap and anonymous, so it is
 * the easiest to flood. Three dimensions:
 *
 *  - `request_volume` — sheer request count from one subject.
 *  - `duplicate_pressure` — the same request resubmitted, which the existing
 *    per-contact quota already suppresses per contact but not per subject.
 *  - `contact_fanout` — one subject referencing many distinct contacts, i.e.
 *    using the queue to message third parties.
 *
 * Contact values are never read here: the aggregate carries counts and salted
 * digests only, so a complainant's address stays out of the abuse record.
 */
export class SupportFloodingDetector implements AbuseDetector {
  readonly kind = AbuseSignalKind.SUPPORT_FLOODING;
  readonly id = 'support.volume_duplicate_fanout.v1';

  constructor(
    private readonly options: {
      maxRequests: number;
      maxDuplicateRequests: number;
      maxDistinctContacts: number;
    },
  ) {}

  evaluate(context: AbuseDetectorContext): ReturnType<AbuseDetector['evaluate']> {
    const signals: ReturnType<AbuseDetector['evaluate']> = [];
    const { window } = context;

    // Scoped to support-surface requests only. Keying this off the subject's total
    // observation count would let ordinary browsing pressure elsewhere look
    // like support flooding.
    if (window.supportRequests > this.options.maxRequests) {
      signals.push({
        kind: this.kind,
        reasonCode: AbuseReasonCode.SUPPORT_VOLUME_FLOOD,
        dimension: 'request_volume',
        sampleCount: window.supportRequests,
        confidence: ratioConfidence(
          window.supportRequests,
          this.options.maxRequests,
        ),
      });
    }

    if (window.supportDuplicateRequests > this.options.maxDuplicateRequests) {
      signals.push({
        kind: this.kind,
        reasonCode: AbuseReasonCode.SUPPORT_DUPLICATE_FLOOD,
        dimension: 'duplicate_pressure',
        sampleCount: window.supportDuplicateRequests,
        confidence: ratioConfidence(
          window.supportDuplicateRequests,
          this.options.maxDuplicateRequests,
        ),
      });
    }

    // Saturation means at least `distinctCap` contacts, already far past the
    // threshold; report the threshold crossing once rather than the cap.
    const contacts = window.supportContactSaturationHit
      ? this.options.maxDistinctContacts + 1
      : window.supportDistinctContacts;
    if (contacts > this.options.maxDistinctContacts) {
      signals.push({
        kind: this.kind,
        reasonCode: AbuseReasonCode.SUPPORT_CONTACT_FANOUT,
        dimension: 'contact_fanout',
        sampleCount: contacts,
        confidence: window.supportContactSaturationHit
          ? 1
          : ratioConfidence(
              window.supportDistinctContacts,
              this.options.maxDistinctContacts,
            ),
      });
    }

    return signals;
  }
}
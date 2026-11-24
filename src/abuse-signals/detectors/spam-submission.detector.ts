import { AbuseSignalKind, AbuseReasonCode } from '../abuse-signals.types';
import {
  AbuseDetector,
  AbuseDetectorContext,
  ratioConfidence,
} from './abuse-detector';

/**
 * Spam submission detector (PREWAVE-BE-086, #681).
 *
 * Spam is measured on two independent dimensions: raw submission velocity
 * (`write_velocity`) and payload repetition (`payload_repetition`). A client
 * that legitimately submits in a loop — an importer, a bulk migration — trips
 * velocity alone and therefore stays a finding, not an action, unless the
 * payloads also repeat.
 *
 * The payload is only ever seen as a salted fingerprint supplied by the
 * caller, so no submitted content, evidence reference or signature is read,
 * stored or compared here.
 */
export class SpamSubmissionDetector implements AbuseDetector {
  readonly kind = AbuseSignalKind.SPAM_SUBMISSION;
  readonly id = 'spam.velocity_repetition.v1';

  constructor(
    private readonly options: { maxWrites: number; maxDuplicatePayloads: number },
  ) {}

  evaluate(context: AbuseDetectorContext): ReturnType<AbuseDetector['evaluate']> {
    const signals: ReturnType<AbuseDetector['evaluate']> = [];
    const { window } = context;

    if (window.writes > this.options.maxWrites) {
      signals.push({
        kind: this.kind,
        reasonCode: AbuseReasonCode.SPAM_SUBMISSION_WRITE_BURST,
        dimension: 'write_velocity',
        sampleCount: window.writes,
        confidence: ratioConfidence(window.writes, this.options.maxWrites),
      });
    }

    if (window.duplicatePayloadRepeats > this.options.maxDuplicatePayloads) {
      signals.push({
        kind: this.kind,
        reasonCode: AbuseReasonCode.SPAM_SUBMISSION_DUPLICATE_PAYLOAD,
        dimension: 'payload_repetition',
        sampleCount: window.duplicatePayloadRepeats,
        confidence: ratioConfidence(
          window.duplicatePayloadRepeats,
          this.options.maxDuplicatePayloads,
        ),
      });
    }

    return signals;
  }
}
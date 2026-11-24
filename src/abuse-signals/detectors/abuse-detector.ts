import { AbuseSignal, AbuseSignalKind } from '../abuse-signals.types';

/**
 * Detector contract (PREWAVE-BE-086, #681).
 *
 * A detector is a **pure function of the aggregate window**: it reads counters
 * and emits findings, and it never issues, applies or mutates an action. That
 * separation is what lets the same detector run on any replica, be replayed
 * against a stored window in a test, and be unit-tested without a store, a
 * clock or a network.
 *
 * Detectors are deliberately coarse and volume-based. Anything that needed a
 * content judgement (evidence validity, claim truth, dispute merit) belongs in
 * moderation, not here: this module sees counts, never protocol meaning.
 */

/** Everything a detector may read. */
export interface AbuseDetectorContext {
  /** The subject's aggregate for the current fixed window. */
  window: {
    reads: number;
    writes: number;
    authFailures: number;
    authSuccesses: number;
    distinctRoutes: number;
    distinctCredentials: number;
    credentialSaturationHit: boolean;
    routeSaturationHit: boolean;
    duplicatePayloadRepeats: number;
    supportDuplicateRequests: number;
    /** Requests observed on the support surface specifically. */
    supportRequests: number;
    supportDistinctContacts: number;
    supportContactSaturationHit: boolean;
    webhookEndpointWrites: number;
    webhookSecretRotations: number;
    webhookDeliveries: number;
    streamConnect: number;
    streamDisconnect: number;
    streamSubscribeOps: number;
    streamMessages: number;
  };
  /**
   * True when the subject is a masked network prefix, i.e. possibly many
   * unrelated people behind one NAT. Findings for such subjects need extra
   * corroboration before they can produce an action.
   */
  sharedEgress: boolean;
  /**
   * Largest number of distinct subjects that presented any single credential
   * fingerprint in this window. Backs "one credential, many subjects", which is
   * only visible across subjects and therefore lives in the shared store.
   */
  maxDistinctSubjectsPerCredential: number;
  /** Whether the subject has an open appeal, which freezes escalation. */
  appealPending: boolean;
}

/** Constructor arguments shared by the volume detectors. */
export interface AbuseDetectorOptions {
  kind: AbuseSignalKind;
  id: string;
}

/** A unit of detection, bound to one abuse class. */
export interface AbuseDetector {
  /** The abuse class this detector is responsible for. */
  readonly kind: AbuseSignalKind;
  /**
   * Stable detector identifier, recorded on findings so a decision can be
   * traced to the code that produced it. Bump the model version if the meaning
   * of an existing id changes.
   */
  readonly id: string;
  evaluate(context: AbuseDetectorContext): AbuseSignal[];
}

/** Maps a ratio over a threshold into a bounded [0,1] confidence. */
export function ratioConfidence(observed: number, threshold: number): number {
  if (threshold <= 0) return 1;
  const ratio = observed / threshold;
  if (!Number.isFinite(ratio) || ratio <= 1) return 0;
  // Sqrt keeps confidence monotonic without saturating instantly, and caps at 1.
  return Math.min(1, Math.sqrt(ratio - 1));
}
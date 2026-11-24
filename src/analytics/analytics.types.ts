/** Optional product analytics only — not operational Prometheus metrics. */

export type ConsentStatus = 'granted' | 'withdrawn' | 'none';

export interface AnalyticsConsentRecord {
  subjectId: string;
  status: ConsentStatus;
  /** Consent policy version the subject accepted. */
  policyVersion: string;
  grantedAt: string | null;
  withdrawnAt: string | null;
  /** When true, subject sent DNT / GPC-style signal. */
  doNotTrack: boolean;
}

export interface AnalyticsEventInput {
  name: string;
  schemaVersion: number;
  subjectId: string;
  /** Raw properties; will be minimized against the schema allowlist. */
  properties?: Record<string, unknown>;
  /** Request DNT header / client signal. */
  doNotTrack?: boolean;
}

export type EmitResult =
  | { ok: true; event: MinimizedAnalyticsEvent }
  | {
      ok: false;
      reason:
        | 'no_consent'
        | 'withdrawn'
        | 'dnt'
        | 'unknown_event'
        | 'schema_mismatch'
        | 'forbidden_field';
    };

export interface MinimizedAnalyticsEvent {
  name: string;
  schemaVersion: number;
  subjectId: string;
  properties: Record<string, unknown>;
  emittedAt: string;
}

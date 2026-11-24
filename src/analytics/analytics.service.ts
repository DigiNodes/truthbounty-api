import { Injectable } from '@nestjs/common';
import { AnalyticsConsentService } from './analytics-consent.service';
import {
  ANALYTICS_SCHEMAS,
  CURRENT_CONSENT_POLICY_VERSION,
  isForbiddenKey,
} from './analytics.schemas';
import {
  AnalyticsEventInput,
  EmitResult,
  MinimizedAnalyticsEvent,
} from './analytics.types';

/**
 * Optional analytics emitter — fail closed without consent.
 * Does not touch Prometheus / MetricsService (operational telemetry).
 */
@Injectable()
export class AnalyticsService {
  /** Captured events for tests / local sink (no external processor by default). */
  private readonly sink: MinimizedAnalyticsEvent[] = [];

  constructor(private readonly consent: AnalyticsConsentService) {}

  getSink(): readonly MinimizedAnalyticsEvent[] {
    return this.sink;
  }

  clearSink(): void {
    this.sink.length = 0;
  }

  emit(input: AnalyticsEventInput): EmitResult {
    const { name, schemaVersion, subjectId } = input;

    if (input.doNotTrack === true) {
      this.consent.setDoNotTrack(subjectId, true);
      return { ok: false, reason: 'dnt' };
    }

    const record = this.consent.get(subjectId);
    if (record.doNotTrack) {
      return { ok: false, reason: 'dnt' };
    }
    if (record.status === 'none') {
      return { ok: false, reason: 'no_consent' };
    }
    if (record.status === 'withdrawn') {
      return { ok: false, reason: 'withdrawn' };
    }
    // Granted but policy version mismatch → treat as no valid consent
    if (record.policyVersion !== CURRENT_CONSENT_POLICY_VERSION) {
      // Allow if caller renewed to current; otherwise block
      if (!this.consent.hasValidConsent(subjectId, CURRENT_CONSENT_POLICY_VERSION)) {
        return { ok: false, reason: 'no_consent' };
      }
    }

    const versions = ANALYTICS_SCHEMAS[name];
    if (!versions) {
      return { ok: false, reason: 'unknown_event' };
    }
    const allowlist = versions[schemaVersion];
    if (!allowlist) {
      return { ok: false, reason: 'schema_mismatch' };
    }

    const raw = input.properties ?? {};
    for (const key of Object.keys(raw)) {
      if (isForbiddenKey(key)) {
        return { ok: false, reason: 'forbidden_field' };
      }
    }

    const properties: Record<string, unknown> = {};
    for (const key of allowlist) {
      if (Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined) {
        properties[key] = raw[key];
      }
    }

    const event: MinimizedAnalyticsEvent = {
      name,
      schemaVersion,
      subjectId,
      properties,
      emittedAt: new Date().toISOString(),
    };
    this.sink.push(event);
    return { ok: true, event };
  }
  }

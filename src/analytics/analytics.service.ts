import { Injectable } from '@nestjs/common';
import { AnalyticsConsentService } from './analytics-consent.service';
import type { ConsentCollectionResult } from './analytics-consent.service';
import { ANALYTICS_SCHEMAS, isForbiddenKey } from './analytics.schemas';
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

  async emit(input: AnalyticsEventInput): Promise<EmitResult> {
    const { name, schemaVersion, subjectId } = input;

    if (input.doNotTrack === true) {
      await this.consent.setDoNotTrack(subjectId, true);
      return { ok: false, reason: 'dnt' };
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
      if (
        Object.prototype.hasOwnProperty.call(raw, key) &&
        raw[key] !== undefined
      ) {
        properties[key] = raw[key];
      }
    }

    const event: MinimizedAnalyticsEvent = {
      name,
      schemaVersion,
      subjectKey: this.consent.getSubjectKey(subjectId),
      properties,
      emittedAt: new Date().toISOString(),
    };
    let captured = false;
    let result: ConsentCollectionResult<MinimizedAnalyticsEvent>;
    try {
      result = await this.consent.collectIfValid(subjectId, async () => {
        this.sink.push(event);
        captured = true;
        return event;
      });
    } catch (error) {
      if (captured) {
        const index = this.sink.lastIndexOf(event);
        if (index >= 0) this.sink.splice(index, 1);
      }
      throw error;
    }
    if (!result.allowed) return { ok: false, reason: result.reason };

    return { ok: true, event: result.value };
  }
}

import { AbuseSignalKind, AbuseReasonCode } from '../abuse-signals.types';
import {
  AbuseDetector,
  AbuseDetectorContext,
  ratioConfidence,
} from './abuse-detector';

/**
 * Scraping detector (PREWAVE-BE-086, #681).
 *
 * Scraping looks like *breadth without identity*: an anonymous subject walking
 * a large number of distinct route groups at a read velocity far above a human
 * browsing session. Volume and breadth are reported as **separate dimensions**
 * so that a single loud axis cannot clear the corroboration bar on its own —
 * which is what keeps a bursty but legitimate client (a dashboard polling one
 * route, a crawler the operator opted into) out of the action path.
 */
export class ScrapingDetector implements AbuseDetector {
  readonly kind = AbuseSignalKind.SCRAPING;
  readonly id = 'scraping.breadth_velocity.v1';

  constructor(
    private readonly options: {
      maxAnonymousReads: number;
      maxDistinctRoutes: number;
    },
  ) {}

  evaluate(context: AbuseDetectorContext): ReturnType<AbuseDetector['evaluate']> {
    const signals: ReturnType<AbuseDetector['evaluate']> = [];
    const { window } = context;

    if (window.reads > this.options.maxAnonymousReads) {
      signals.push({
        kind: this.kind,
        reasonCode: AbuseReasonCode.SCRAPE_SUSTAINED_READ_VELOCITY,
        dimension: 'read_volume',
        sampleCount: window.reads,
        confidence: ratioConfidence(window.reads, this.options.maxAnonymousReads),
      });
    }

    // Saturation means the distinct set hit its cap, i.e. breadth is *at least*
    // the cap. That is never a reason to be more suspicious than the raw count
    // justifies, so the cap itself is not treated as extra confidence.
    if (window.distinctRoutes > this.options.maxDistinctRoutes) {
      signals.push({
        kind: this.kind,
        reasonCode: AbuseReasonCode.SCRAPE_HIGH_BREADTH_ANONYMOUS,
        dimension: 'route_breadth',
        sampleCount: window.distinctRoutes,
        confidence: ratioConfidence(
          window.distinctRoutes,
          this.options.maxDistinctRoutes,
        ),
      });
    }

    return signals;
  }
}
import { AbuseSignalKind, AbuseReasonCode } from '../abuse-signals.types';
import {
  AbuseDetector,
  AbuseDetectorContext,
  ratioConfidence,
} from './abuse-detector';

/**
 * Webhook abuse detector (PREWAVE-BE-086, #681).
 *
 * Three separate dimensions, because they have different causes and different
 * legitimate explanations:
 *
 *  - `endpoint_churn` — many create/update/delete calls in one window.
 *  - `secret_rotation` — repeated secret rotations, which is both a delivery
 *    cost to the platform and a way to shed delivery evidence.
 *  - `delivery_storm` — outbound delivery/replay volume from one owner.
 *
 * Destination URLs, payloads and signing secrets are never inspected: the
 * observations carry counts only, so a subscriber's endpoint and its traffic
 * stay outside this module.
 */
export class WebhookAbuseDetector implements AbuseDetector {
  readonly kind = AbuseSignalKind.WEBHOOK_ABUSE;
  readonly id = 'webhook.churn_rotation_storm.v1';

  constructor(
    private readonly options: {
      maxEndpointWrites: number;
      maxSecretRotations: number;
      maxDeliveries: number;
    },
  ) {}

  evaluate(context: AbuseDetectorContext): ReturnType<AbuseDetector['evaluate']> {
    const signals: ReturnType<AbuseDetector['evaluate']> = [];
    const { window } = context;

    if (window.webhookEndpointWrites > this.options.maxEndpointWrites) {
      signals.push({
        kind: this.kind,
        reasonCode: AbuseReasonCode.WEBHOOK_ENDPOINT_CHURN,
        dimension: 'endpoint_churn',
        sampleCount: window.webhookEndpointWrites,
        confidence: ratioConfidence(
          window.webhookEndpointWrites,
          this.options.maxEndpointWrites,
        ),
      });
    }

    if (window.webhookSecretRotations > this.options.maxSecretRotations) {
      signals.push({
        kind: this.kind,
        reasonCode: AbuseReasonCode.WEBHOOK_SECRET_ROTATION_ABUSE,
        dimension: 'secret_rotation',
        sampleCount: window.webhookSecretRotations,
        confidence: ratioConfidence(
          window.webhookSecretRotations,
          this.options.maxSecretRotations,
        ),
      });
    }

    if (window.webhookDeliveries > this.options.maxDeliveries) {
      signals.push({
        kind: this.kind,
        reasonCode: AbuseReasonCode.WEBHOOK_DELIVERY_STORM,
        dimension: 'delivery_storm',
        sampleCount: window.webhookDeliveries,
        confidence: ratioConfidence(
          window.webhookDeliveries,
          this.options.maxDeliveries,
        ),
      });
    }

    return signals;
  }
}
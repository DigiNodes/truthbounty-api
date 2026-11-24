import { Logger } from '@nestjs/common';
import { DeliveryChannel } from '../../interfaces/notification.types';
import { narrowDeliveryError } from '../../delivery/delivery-error';
import type { RenderedNotificationPayload } from '../../delivery/rendered-notification-payload';

export interface DeliveryResult {
  success: boolean;
  deliveredAt?: Date;
  failureReason?: string;
  responseData?: Record<string, unknown>;
}

/**
 * Base class for every notification delivery worker.
 *
 * Workers accept exactly one payload type — the canonical
 * `RenderedNotificationPayload` — and never the persistence entities. Provider
 * failures are narrowed into domain errors before any provider-specific field
 * is inspected, so callers can rely on `failureReason` being safe to surface.
 */
export abstract class BaseDeliveryService {
  protected abstract readonly logger: Logger;

  abstract get channel(): DeliveryChannel;

  abstract deliver(
    payload: RenderedNotificationPayload,
  ): Promise<DeliveryResult>;

  /**
   * Read the provider destination (email address, push token, webhook URL,
   * phone number) from opaque payload metadata. Never logs the value.
   */
  protected resolveDestination(
    payload: RenderedNotificationPayload,
  ): string | null {
    const value = payload.metadata?.destination;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  /** Build a sanitized failure result from an arbitrary thrown value. */
  protected failure(error: unknown): DeliveryResult {
    const narrowed = narrowDeliveryError(error, { channel: this.channel });
    return {
      success: false,
      failureReason: narrowed.message,
      responseData: {
        kind: narrowed.kind,
        retryable: narrowed.retryable,
      },
    };
  }
}

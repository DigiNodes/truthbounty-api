import { DeliveryChannel } from '../interfaces/notification.types';
import {
  parseDeliveryChannel,
  requireDeliveryChannel,
} from './delivery-channel';
import { UnknownDeliveryChannelError } from './delivery-error';
import { RenderedNotificationPayload } from './rendered-notification-payload';

/** A delivery worker able to deliver one canonical payload. */
export interface DeliveryProvider<Result> {
  readonly channel: DeliveryChannel;
  deliver(payload: RenderedNotificationPayload): Promise<Result>;
}

/**
 * Resolves a (possibly untrusted) channel value to exactly one provider.
 *
 * The resolver is the only place a channel reaches a provider: it canonicalizes
 * the value and throws a terminal `UnknownDeliveryChannelError` for null,
 * undefined, empty, or unmapped channels. Providers are therefore never invoked
 * with an unknown channel.
 */
export class DeliveryChannelResolver<Result> {
  private readonly providers = new Map<
    DeliveryChannel,
    DeliveryProvider<Result>
  >();

  constructor(providers: readonly DeliveryProvider<Result>[] = []) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider: DeliveryProvider<Result>): void {
    const canonical = requireDeliveryChannel(provider.channel);
    this.providers.set(canonical, provider);
  }

  has(value: unknown): boolean {
    const canonical = parseDeliveryChannel(value);
    return canonical !== null && this.providers.has(canonical);
  }

  /** Resolve a provider or throw; never returns a provider for unknown input. */
  resolve(value: unknown): DeliveryProvider<Result> {
    const canonical = parseDeliveryChannel(value);
    if (canonical === null) {
      throw new UnknownDeliveryChannelError(
        `Cannot resolve delivery provider for channel: ${String(value)}`,
      );
    }

    const provider = this.providers.get(canonical);
    if (!provider) {
      throw new UnknownDeliveryChannelError(
        `No delivery provider registered for channel: ${canonical}`,
      );
    }

    return provider;
  }

  async deliver(
    value: unknown,
    payload: RenderedNotificationPayload,
  ): Promise<Result> {
    return this.resolve(value).deliver(payload);
  }

  get registeredChannels(): DeliveryChannel[] {
    return Array.from(this.providers.keys());
  }
}

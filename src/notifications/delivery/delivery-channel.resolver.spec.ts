import {
  DeliveryChannelResolver,
  DeliveryProvider,
} from './delivery-channel.resolver';
import { DeliveryChannel } from '../interfaces/notification.types';
import { EventType } from '../enums/event-type.enum';
import { UnknownDeliveryChannelError } from './delivery-error';
import type { RenderedNotificationPayload } from './rendered-notification-payload';

function createPayload(channel: DeliveryChannel): RenderedNotificationPayload {
  return {
    notificationId: 'notif-1',
    userId: 'user-1',
    channel,
    eventType: EventType.SYSTEM_ALERT,
    rendered: { body: 'hello' },
    metadata: {},
  };
}

function createProvider(
  channel: DeliveryChannel,
): DeliveryProvider<string> & { deliver: jest.Mock } {
  return {
    channel,
    deliver: jest.fn().mockResolvedValue('delivered'),
  };
}

describe('DeliveryChannelResolver', () => {
  it('routes a canonical channel to its provider', async () => {
    const provider = createProvider(DeliveryChannel.EMAIL);
    const resolver = new DeliveryChannelResolver([provider]);

    await expect(
      resolver.deliver(
        DeliveryChannel.EMAIL,
        createPayload(DeliveryChannel.EMAIL),
      ),
    ).resolves.toBe('delivered');
    expect(provider.deliver).toHaveBeenCalledTimes(1);
  });

  it('migrates legacy uppercase channel spellings', () => {
    const provider = createProvider(DeliveryChannel.IN_APP);
    const resolver = new DeliveryChannelResolver([provider]);

    expect(resolver.resolve('IN_APP')).toBe(provider);
    expect(resolver.has('In-App')).toBe(true);
  });

  it.each([null, undefined, '', '   ', 'carrier-pigeon', 42, {}])(
    'refuses to resolve the unknown channel %p',
    (value) => {
      const provider = createProvider(DeliveryChannel.EMAIL);
      const resolver = new DeliveryChannelResolver([provider]);

      expect(() => resolver.resolve(value as unknown)).toThrow(
        UnknownDeliveryChannelError,
      );
      expect(resolver.has(value as unknown)).toBe(false);
    },
  );

  it('never calls a provider for a null or unknown channel', async () => {
    const provider = createProvider(DeliveryChannel.EMAIL);
    const resolver = new DeliveryChannelResolver([provider]);
    const payload = createPayload(DeliveryChannel.EMAIL);

    await expect(resolver.deliver(null, payload)).rejects.toThrow(
      UnknownDeliveryChannelError,
    );
    await expect(resolver.deliver('unknown-channel', payload)).rejects.toThrow(
      UnknownDeliveryChannelError,
    );

    expect(provider.deliver).not.toHaveBeenCalled();
  });

  it('refuses to register a provider with an unknown channel', () => {
    const resolver = new DeliveryChannelResolver();
    expect(() =>
      resolver.register(createProvider('bogus' as DeliveryChannel)),
    ).toThrow(UnknownDeliveryChannelError);
  });

  it('exposes the registered canonical channels', () => {
    const resolver = new DeliveryChannelResolver([
      createProvider(DeliveryChannel.EMAIL),
      createProvider(DeliveryChannel.SMS),
    ]);

    expect(resolver.registeredChannels.sort()).toEqual(
      [DeliveryChannel.EMAIL, DeliveryChannel.SMS].sort(),
    );
  });
});

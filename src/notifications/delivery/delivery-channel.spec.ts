import {
  parseDeliveryChannel,
  requireDeliveryChannel,
  toWireDeliveryChannel,
  normalizeChannelPreferences,
  serializeChannelPreferences,
  createDefaultChannelPreferences,
  isDeliveryChannel,
  CANONICAL_DELIVERY_CHANNELS,
} from './delivery-channel';
import { DeliveryChannel } from '../interfaces/notification.types';
import { UnknownDeliveryChannelError } from './delivery-error';

describe('canonical delivery channels', () => {
  describe('exhaustive enum/union compilation and verification', () => {
    it('verifies all expected canonical channels exist and are lowercase string enums', () => {
      const expectedChannels: DeliveryChannel[] = [
        DeliveryChannel.IN_APP,
        DeliveryChannel.WEBSOCKET,
        DeliveryChannel.PUSH,
        DeliveryChannel.EMAIL,
        DeliveryChannel.WEBHOOK,
        DeliveryChannel.SMS,
      ];

      expect(CANONICAL_DELIVERY_CHANNELS).toHaveLength(expectedChannels.length);
      for (const ch of expectedChannels) {
        expect(CANONICAL_DELIVERY_CHANNELS).toContain(ch);
        expect(isDeliveryChannel(ch)).toBe(true);
      }
    });

    it('parses every canonical channel value to itself', () => {
      for (const channel of Object.values(DeliveryChannel)) {
        expect(parseDeliveryChannel(channel)).toBe(channel);
      }
    });
  });

  describe('legacy-case and alias migration without heuristics', () => {
    it('migrates exact uppercase string literals to canonical values', () => {
      expect(parseDeliveryChannel('IN_APP')).toBe(DeliveryChannel.IN_APP);
      expect(parseDeliveryChannel('WEBSOCKET')).toBe(DeliveryChannel.WEBSOCKET);
      expect(parseDeliveryChannel('PUSH')).toBe(DeliveryChannel.PUSH);
      expect(parseDeliveryChannel('EMAIL')).toBe(DeliveryChannel.EMAIL);
      expect(parseDeliveryChannel('WEBHOOK')).toBe(DeliveryChannel.WEBHOOK);
      expect(parseDeliveryChannel('SMS')).toBe(DeliveryChannel.SMS);
    });

    it('migrates documented legacy aliases', () => {
      expect(parseDeliveryChannel('inapp')).toBe(DeliveryChannel.IN_APP);
      expect(parseDeliveryChannel('in-app')).toBe(DeliveryChannel.IN_APP);
      expect(parseDeliveryChannel('INAPP')).toBe(DeliveryChannel.IN_APP);
      expect(parseDeliveryChannel('ws')).toBe(DeliveryChannel.WEBSOCKET);
      expect(parseDeliveryChannel('WS')).toBe(DeliveryChannel.WEBSOCKET);
      expect(parseDeliveryChannel('socket')).toBe(DeliveryChannel.WEBSOCKET);
      expect(parseDeliveryChannel('mail')).toBe(DeliveryChannel.EMAIL);
      expect(parseDeliveryChannel('MAIL')).toBe(DeliveryChannel.EMAIL);
      expect(parseDeliveryChannel('text')).toBe(DeliveryChannel.SMS);
      expect(parseDeliveryChannel('TEXT')).toBe(DeliveryChannel.SMS);
      expect(parseDeliveryChannel('  Webhook  ')).toBe(DeliveryChannel.WEBHOOK);
    });
  });

  describe('unknown, malformed, and null handling (fail closed)', () => {
    it('returns null for null, empty, and unknown values', () => {
      const invalidInputs = [
        null,
        undefined,
        '',
        '   ',
        'carrier-pigeon',
        'random_channel',
        'UNKNOWN',
        42,
        {},
        [],
        true,
      ];

      for (const value of invalidInputs) {
        expect(parseDeliveryChannel(value)).toBeNull();
        expect(isDeliveryChannel(value)).toBe(false);
      }
    });

    it('fails closed when requiring a channel', () => {
      expect(() => requireDeliveryChannel(null)).toThrow(
        UnknownDeliveryChannelError,
      );
      expect(() => requireDeliveryChannel(undefined)).toThrow(
        UnknownDeliveryChannelError,
      );
      expect(() => requireDeliveryChannel('')).toThrow(
        UnknownDeliveryChannelError,
      );
      expect(() => requireDeliveryChannel('carrier-pigeon')).toThrow(
        UnknownDeliveryChannelError,
      );
      expect(requireDeliveryChannel('EMAIL')).toBe(DeliveryChannel.EMAIL);
      expect(requireDeliveryChannel(DeliveryChannel.IN_APP)).toBe(
        DeliveryChannel.IN_APP,
      );
    });
  });

  describe('wire serialization', () => {
    it('serializes with a single canonical wire representation', () => {
      expect(toWireDeliveryChannel(DeliveryChannel.EMAIL)).toBe('email');
      expect(toWireDeliveryChannel(DeliveryChannel.SMS)).toBe('sms');
      expect(toWireDeliveryChannel(DeliveryChannel.IN_APP)).toBe('in_app');
      expect(toWireDeliveryChannel(DeliveryChannel.WEBSOCKET)).toBe('websocket');
      expect(toWireDeliveryChannel(DeliveryChannel.PUSH)).toBe('push');
      expect(toWireDeliveryChannel(DeliveryChannel.WEBHOOK)).toBe('webhook');
    });

    it('fails closed if an unknown value is passed to toWireDeliveryChannel', () => {
      expect(() =>
        toWireDeliveryChannel('carrier-pigeon' as unknown as DeliveryChannel),
      ).toThrow(UnknownDeliveryChannelError);
    });
  });

  describe('ChannelPreferences normalization and round-trip', () => {
    it('creates defaults with canonical keys', () => {
      const defaults = createDefaultChannelPreferences();
      expect(defaults[DeliveryChannel.IN_APP]).toBe(true);
      expect(defaults[DeliveryChannel.WEBSOCKET]).toBe(true);
      expect(defaults[DeliveryChannel.PUSH]).toBe(false);
      expect(defaults[DeliveryChannel.EMAIL]).toBe(true);
      expect(defaults[DeliveryChannel.WEBHOOK]).toBe(false);
      expect(defaults[DeliveryChannel.SMS]).toBe(false);
    });

    it('normalizes legacy uppercase keys to canonical keys and provides backward compatibility getters', () => {
      const legacyRaw = {
        IN_APP: true,
        EMAIL: false,
        WEBSOCKET: true,
        PUSH: false,
        WEBHOOK: true,
      };

      const normalized = normalizeChannelPreferences(legacyRaw);
      expect(normalized[DeliveryChannel.IN_APP]).toBe(true);
      expect(normalized[DeliveryChannel.EMAIL]).toBe(false);
      expect(normalized[DeliveryChannel.WEBSOCKET]).toBe(true);
      expect(normalized[DeliveryChannel.PUSH]).toBe(false);
      expect(normalized[DeliveryChannel.WEBHOOK]).toBe(true);

      // Verify uppercase non-enumerable accessor backward compatibility
      expect(normalized.IN_APP).toBe(true);
      expect(normalized.EMAIL).toBe(false);
      expect(normalized.WEBSOCKET).toBe(true);
      expect(normalized.PUSH).toBe(false);
      expect(normalized.WEBHOOK).toBe(true);
    });

    it('serializes only canonical keys for persistence / wire output', () => {
      const legacyRaw = {
        IN_APP: true,
        EMAIL: false,
        UNKNOWN_CHANNEL: true,
      };

      const normalized = normalizeChannelPreferences(legacyRaw);
      const serialized = serializeChannelPreferences(normalized);

      const keys = Object.keys(serialized);
      expect(keys).toEqual([
        'in_app',
        'websocket',
        'push',
        'email',
        'webhook',
        'sms',
      ]);
      expect(keys).not.toContain('IN_APP');
      expect(keys).not.toContain('UNKNOWN_CHANNEL');

      // Round-trip through JSON
      const jsonRoundTrip = JSON.parse(JSON.stringify(serialized));
      expect(jsonRoundTrip['in_app']).toBe(true);
      expect(jsonRoundTrip['email']).toBe(false);
    });
  });
});

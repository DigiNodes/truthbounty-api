import { DeliveryChannel } from '../interfaces/notification.types';
import type { ChannelPreferences } from '../entities/notification-preference.entity';
import { UnknownDeliveryChannelError } from './delivery-error';

export { DeliveryChannel };

/**
 * Canonical dictionary mapping supported wire values, documented legacy uppercase
 * string literals, and aliases to the single canonical DeliveryChannel enum.
 *
 * Case-conversion heuristics (such as indiscriminate toLowerCase/toUpperCase) are
 * explicitly avoided in favor of exact, deterministic dictionary reconciliation.
 */
export const DELIVERY_CHANNEL_MAP: Readonly<Record<string, DeliveryChannel>> = {
  // Canonical wire/persistence representation (lower_snake_case)
  [DeliveryChannel.IN_APP]: DeliveryChannel.IN_APP,
  [DeliveryChannel.WEBSOCKET]: DeliveryChannel.WEBSOCKET,
  [DeliveryChannel.PUSH]: DeliveryChannel.PUSH,
  [DeliveryChannel.EMAIL]: DeliveryChannel.EMAIL,
  [DeliveryChannel.WEBHOOK]: DeliveryChannel.WEBHOOK,
  [DeliveryChannel.SMS]: DeliveryChannel.SMS,

  // Documented legacy uppercase literals
  IN_APP: DeliveryChannel.IN_APP,
  WEBSOCKET: DeliveryChannel.WEBSOCKET,
  PUSH: DeliveryChannel.PUSH,
  EMAIL: DeliveryChannel.EMAIL,
  WEBHOOK: DeliveryChannel.WEBHOOK,
  SMS: DeliveryChannel.SMS,

  // Documented legacy aliases and casings
  Webhook: DeliveryChannel.WEBHOOK,
  Email: DeliveryChannel.EMAIL,
  Push: DeliveryChannel.PUSH,
  Websocket: DeliveryChannel.WEBSOCKET,
  WebSocket: DeliveryChannel.WEBSOCKET,
  InApp: DeliveryChannel.IN_APP,
  In_App: DeliveryChannel.IN_APP,
  Sms: DeliveryChannel.SMS,
  inapp: DeliveryChannel.IN_APP,
  'in-app': DeliveryChannel.IN_APP,
  INAPP: DeliveryChannel.IN_APP,
  'IN-APP': DeliveryChannel.IN_APP,
  ws: DeliveryChannel.WEBSOCKET,
  WS: DeliveryChannel.WEBSOCKET,
  socket: DeliveryChannel.WEBSOCKET,
  SOCKET: DeliveryChannel.WEBSOCKET,
  mail: DeliveryChannel.EMAIL,
  MAIL: DeliveryChannel.EMAIL,
  text: DeliveryChannel.SMS,
  TEXT: DeliveryChannel.SMS,
};

/** All canonical DeliveryChannel values. */
export const CANONICAL_DELIVERY_CHANNELS: readonly DeliveryChannel[] =
  Object.freeze(Object.values(DeliveryChannel));

/**
 * Type guard for canonical DeliveryChannel.
 */
export function isDeliveryChannel(value: unknown): value is DeliveryChannel {
  return (
    typeof value === 'string' &&
    CANONICAL_DELIVERY_CHANNELS.includes(value as DeliveryChannel)
  );
}

/**
 * Reconcile an untrusted channel identifier into the canonical DeliveryChannel enum.
 *
 * Returns `null` if the input is null, undefined, empty, or unmapped, allowing
 * consumers to fail closed. Legacy uppercase literals ('IN_APP', 'EMAIL', etc.)
 * migrate deterministically to canonical lower_snake_case values without heuristics.
 */
export function parseDeliveryChannel(value: unknown): DeliveryChannel | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return DELIVERY_CHANNEL_MAP[trimmed] ?? null;
}

/**
 * Produce the single wire representation for a delivery channel.
 *
 * Wire and internal representations are unified to the canonical lower_snake_case value.
 */
export function toWireDeliveryChannel(channel: DeliveryChannel): string {
  const canonical = parseDeliveryChannel(channel);
  if (!canonical) {
    throw new UnknownDeliveryChannelError(
      `Cannot serialize unmapped delivery channel: ${String(channel)}`,
    );
  }
  return canonical;
}

/**
 * Require a valid delivery channel or fail closed with UnknownDeliveryChannelError.
 *
 * Used at network and worker boundaries to ensure unknown or null channels never
 * reach providers or delivery pipelines.
 */
export function requireDeliveryChannel(value: unknown): DeliveryChannel {
  const canonical = parseDeliveryChannel(value);
  if (canonical === null) {
    throw new UnknownDeliveryChannelError(
      `Unknown or missing delivery channel: ${describeChannelValue(value)}`,
    );
  }
  return canonical;
}

/**
 * Reconcile untrusted channel preference dictionaries or persistence records into
 * canonical ChannelPreferences.
 *
 * Migrates legacy uppercase keys ('IN_APP', 'EMAIL', etc.) to canonical DeliveryChannel
 * keys ('in_app', 'email', etc.). Unknown/unmapped keys are rejected and omitted,
 * preventing corrupt states from propagating.
 */
export function normalizeChannelPreferences(
  raw: unknown,
): ChannelPreferences {
  if (!raw || typeof raw !== 'object') {
    return createDefaultChannelPreferences();
  }

  // Handle array of channel identifiers
  if (Array.isArray(raw)) {
    const result: ChannelPreferences = {};
    for (const item of raw) {
      const canonical = parseDeliveryChannel(item);
      if (canonical) {
        result[canonical] = true;
      }
    }
    attachLegacyPropertyAccessors(result);
    return result;
  }

  const result: ChannelPreferences = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const canonical = parseDeliveryChannel(key);
    if (canonical !== null && typeof value === 'boolean') {
      result[canonical] = value;
    }
  }

  attachLegacyPropertyAccessors(result);
  return result;
}

/**
 * Serializes ChannelPreferences for wire or database persistence.
 *
 * Guarantees that only canonical DeliveryChannel keys are serialized.
 */
export function serializeChannelPreferences(
  prefs: ChannelPreferences,
): Record<string, boolean> {
  const normalized = normalizeChannelPreferences(prefs);
  const serialized: Record<string, boolean> = {};
  for (const key of CANONICAL_DELIVERY_CHANNELS) {
    if (normalized[key] !== undefined) {
      serialized[key] = Boolean(normalized[key]);
    }
  }
  return serialized;
}

/**
 * Create canonical default ChannelPreferences.
 */
export function createDefaultChannelPreferences(): ChannelPreferences {
  const result: ChannelPreferences = {
    [DeliveryChannel.IN_APP]: true,
    [DeliveryChannel.EMAIL]: true,
    [DeliveryChannel.PUSH]: false,
    [DeliveryChannel.WEBHOOK]: false,
    [DeliveryChannel.WEBSOCKET]: true,
    [DeliveryChannel.SMS]: false,
  };
  attachLegacyPropertyAccessors(result);
  return result;
}

/**
 * Attach non-enumerable legacy property accessors (e.g. .IN_APP -> .in_app)
 * to support backward compatibility without polluting serialized JSON or Object.keys.
 */
function attachLegacyPropertyAccessors(prefs: ChannelPreferences): void {
  const legacyAliases: Array<[string, DeliveryChannel]> = [
    ['IN_APP', DeliveryChannel.IN_APP],
    ['EMAIL', DeliveryChannel.EMAIL],
    ['PUSH', DeliveryChannel.PUSH],
    ['WEBHOOK', DeliveryChannel.WEBHOOK],
    ['WEBSOCKET', DeliveryChannel.WEBSOCKET],
    ['SMS', DeliveryChannel.SMS],
  ];

  for (const [legacyKey, canonicalKey] of legacyAliases) {
    if (!Object.prototype.hasOwnProperty.call(prefs, legacyKey)) {
      Object.defineProperty(prefs, legacyKey, {
        get() {
          return this[canonicalKey];
        },
        set(value: boolean | undefined) {
          this[canonicalKey] = value;
        },
        enumerable: false,
        configurable: true,
      });
    }
  }
}

/** Render an untrusted channel value for a sanitized error message. */
function describeChannelValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value.length === 0 ? '<empty>' : value;
  return typeof value;
}

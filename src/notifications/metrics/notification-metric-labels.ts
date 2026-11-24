import { DeliveryChannel } from '../interfaces/notification.types';
import { EventType } from '../enums/event-type.enum';

export const CHANNEL_LABEL_OTHER = 'other';
export const EVENT_TYPE_LABEL_OTHER = 'other';

export const CHANNEL_LABEL_VALUES: readonly string[] =
  Object.values(DeliveryChannel);
export const EVENT_TYPE_LABEL_VALUES: readonly string[] =
  Object.values(EventType);

export const FAILURE_REASONS = [
  'timeout',
  'rate_limited',
  'network_error',
  'provider_error',
  'unauthorized',
  'not_found',
  'invalid_payload',
  'unknown',
] as const;

export type FailureReasonLabel = (typeof FAILURE_REASONS)[number];

export const NOTIFICATION_METRIC_LABEL_KEYS = [
  'channel',
  'event_type',
  'reason',
] as const;

export function toChannelLabel(channel: unknown): string {
  if (typeof channel === 'string' && CHANNEL_LABEL_VALUES.includes(channel)) {
    return channel;
  }
  return CHANNEL_LABEL_OTHER;
}

export function toEventTypeLabel(eventType: unknown): string {
  if (
    typeof eventType === 'string' &&
    EVENT_TYPE_LABEL_VALUES.includes(eventType)
  ) {
    return eventType;
  }
  return EVENT_TYPE_LABEL_OTHER;
}

export function toFailureReasonLabel(reason: unknown): FailureReasonLabel {
  if (typeof reason !== 'string' || reason.length === 0) {
    return 'unknown';
  }

  const value = reason.toLowerCase();

  if (
    value.includes('timeout') ||
    value.includes('timed out') ||
    value.includes('timedout') ||
    value.includes('timed_out')
  ) {
    return 'timeout';
  }
  if (
    (value.includes('rate') && value.includes('limit')) ||
    value.includes('429') ||
    value.includes('too many')
  ) {
    return 'rate_limited';
  }
  if (
    value.includes('econn') ||
    value.includes('enotfound') ||
    value.includes('network') ||
    value.includes('socket') ||
    value.includes('fetch failed') ||
    value.includes('dns')
  ) {
    return 'network_error';
  }
  if (
    value.includes('401') ||
    value.includes('403') ||
    value.includes('unauthorized') ||
    value.includes('forbidden')
  ) {
    return 'unauthorized';
  }
  if (value.includes('404') || value.includes('not found')) {
    return 'not_found';
  }
  if (
    value.includes('400') ||
    value.includes('invalid') ||
    value.includes('malformed') ||
    value.includes('parse') ||
    value.includes('schema') ||
    value.includes('validation')
  ) {
    return 'invalid_payload';
  }
  if (
    value.includes('500') ||
    value.includes('502') ||
    value.includes('503') ||
    value.includes('504') ||
    value.includes('internal') ||
    value.includes('server') ||
    value.includes('provider') ||
    value.includes('smtp')
  ) {
    return 'provider_error';
  }

  return 'unknown';
}

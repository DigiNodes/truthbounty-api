import { Counter, Histogram, register } from 'prom-client';
import {
  toChannelLabel,
  toEventTypeLabel,
  toFailureReasonLabel,
} from './notification-metric-labels';
import { isNotificationMetricsEnabled } from '../../metrics/metrics-enabled';

const DELIVERY_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

function getOrCreateCounter(
  name: string,
  help: string,
  labelNames: string[],
): Counter<string> {
  const existing = register.getSingleMetric(name);
  if (existing instanceof Counter) {
    return existing;
  }
  return new Counter({ name, help, labelNames, registers: [register] });
}

function getOrCreateDurationHistogram(): Histogram<string> {
  const name = 'notification_delivery_duration_seconds';
  const existing = register.getSingleMetric(name);
  if (existing instanceof Histogram) {
    return existing;
  }
  return new Histogram({
    name,
    help: 'Notification delivery duration in seconds',
    labelNames: ['channel'],
    buckets: DELIVERY_DURATION_BUCKETS,
    registers: [register],
  });
}

export function recordNotificationSent(input: {
  channel: unknown;
  eventType: unknown;
}): void {
  if (!isNotificationMetricsEnabled()) {
    return;
  }
  getOrCreateCounter('notifications_sent_total', 'Total notifications sent', [
    'channel',
    'event_type',
  ]).inc({
    channel: toChannelLabel(input.channel),
    event_type: toEventTypeLabel(input.eventType),
  });
}

export function recordNotificationDelivered(input: {
  channel: unknown;
  eventType: unknown;
  latencyMs: unknown;
}): void {
  if (!isNotificationMetricsEnabled()) {
    return;
  }
  const channel = toChannelLabel(input.channel);
  getOrCreateCounter(
    'notifications_delivered_total',
    'Total notifications delivered',
    ['channel', 'event_type'],
  ).inc({
    channel,
    event_type: toEventTypeLabel(input.eventType),
  });

  if (typeof input.latencyMs === 'number' && Number.isFinite(input.latencyMs)) {
    getOrCreateDurationHistogram().observe(
      { channel },
      Math.max(0, input.latencyMs) / 1000,
    );
  }
}

export function recordNotificationFailed(input: {
  channel: unknown;
  eventType: unknown;
  reason: unknown;
}): void {
  if (!isNotificationMetricsEnabled()) {
    return;
  }
  getOrCreateCounter(
    'notifications_failed_total',
    'Total notifications failed',
    ['channel', 'event_type', 'reason'],
  ).inc({
    channel: toChannelLabel(input.channel),
    event_type: toEventTypeLabel(input.eventType),
    reason: toFailureReasonLabel(input.reason),
  });
}

export function recordNotificationRetryAttempt(input: {
  channel: unknown;
  eventType: unknown;
}): void {
  if (!isNotificationMetricsEnabled()) {
    return;
  }
  getOrCreateCounter(
    'notifications_retried_total',
    'Total notification retry attempts',
    ['channel', 'event_type'],
  ).inc({
    channel: toChannelLabel(input.channel),
    event_type: toEventTypeLabel(input.eventType),
  });
}

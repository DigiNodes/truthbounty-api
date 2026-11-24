import { register } from 'prom-client';
import {
  recordNotificationSent,
  recordNotificationDelivered,
  recordNotificationFailed,
  recordNotificationRetryAttempt,
} from './notification-metrics.registry';
import {
  CHANNEL_LABEL_OTHER,
  CHANNEL_LABEL_VALUES,
  EVENT_TYPE_LABEL_OTHER,
  EVENT_TYPE_LABEL_VALUES,
  FAILURE_REASONS,
} from './notification-metric-labels';
import { DeliveryChannel } from '../interfaces/notification.types';
import { EventType } from '../enums/event-type.enum';

const PII_INPUTS = [
  'user@example.com',
  '0xde709f2102306220921060314715629080e2fb77',
  'claim-3f2b7a91-8c4d-4e5f-9a0b-1c2d3e4f5a6b',
  'Bearer FAKE_CREDENTIAL_VALUE_FOR_TEST',
  'smtp://user:FAKE_PASSWORD_FOR_TEST@mail.example.com:587',
];

function seriesValues(scrape: string, metricName: string): string[] {
  return scrape
    .split('\n')
    .filter((line) => line.startsWith(`${metricName}{`) || line === metricName);
}

describe('notification-metrics.registry', () => {
  beforeEach(() => {
    register.clear();
    delete process.env.METRICS_ENABLED;
  });

  afterAll(() => {
    delete process.env.METRICS_ENABLED;
  });

  it('registers each metric exactly once even when recorded repeatedly', async () => {
    recordNotificationSent({
      channel: DeliveryChannel.EMAIL,
      eventType: EventType.CLAIM_CREATED,
    });
    recordNotificationSent({
      channel: DeliveryChannel.EMAIL,
      eventType: EventType.CLAIM_CREATED,
    });
    recordNotificationDelivered({
      channel: DeliveryChannel.EMAIL,
      eventType: EventType.CLAIM_CREATED,
      latencyMs: 100,
    });
    recordNotificationFailed({
      channel: DeliveryChannel.EMAIL,
      eventType: EventType.CLAIM_CREATED,
      reason: 'timeout',
    });
    recordNotificationRetryAttempt({
      channel: DeliveryChannel.EMAIL,
      eventType: EventType.CLAIM_CREATED,
    });

    expect(register.getSingleMetric('notifications_sent_total')).toBeDefined();
    expect(
      register.getSingleMetric('notifications_delivered_total'),
    ).toBeDefined();
    expect(
      register.getSingleMetric('notifications_failed_total'),
    ).toBeDefined();
    expect(
      register.getSingleMetric('notifications_retried_total'),
    ).toBeDefined();
    expect(
      register.getSingleMetric('notification_delivery_duration_seconds'),
    ).toBeDefined();

    const scrapeJson: any = await (register.getMetricsAsJSON() as any);
    const sent = scrapeJson.find(
      (m: any) => m.name === 'notifications_sent_total',
    );
    expect(sent?.values).toHaveLength(1);
    expect((sent?.values?.[0] as { value: number }).value).toBe(2);
  });

  it('emits only allow-listed label values for valid input', async () => {
    recordNotificationSent({
      channel: DeliveryChannel.PUSH,
      eventType: EventType.DISPUTE_ESCALATED,
    });
    recordNotificationDelivered({
      channel: DeliveryChannel.PUSH,
      eventType: EventType.DISPUTE_ESCALATED,
      latencyMs: 1500,
    });
    recordNotificationFailed({
      channel: DeliveryChannel.PUSH,
      eventType: EventType.DISPUTE_ESCALATED,
      reason: 'HTTP 429 too many requests',
    });
    recordNotificationRetryAttempt({
      channel: DeliveryChannel.PUSH,
      eventType: EventType.DISPUTE_ESCALATED,
    });

    const scrape = await register.metrics();

    expect(scrape).toContain(
      'notifications_sent_total{channel="push",event_type="DISPUTE_ESCALATED"} 1',
    );
    expect(scrape).toContain(
      'notifications_failed_total{channel="push",event_type="DISPUTE_ESCALATED",reason="rate_limited"} 1',
    );
    expect(scrape).toContain(
      'notification_delivery_duration_seconds_sum{channel="push"} 1.5',
    );
  });

  it('keeps labels bounded and redacts PII under adversarial input', async () => {
    for (const raw of PII_INPUTS) {
      recordNotificationSent({ channel: raw, eventType: raw });
      recordNotificationDelivered({
        channel: raw,
        eventType: raw,
        latencyMs: 10,
      });
      recordNotificationFailed({
        channel: raw,
        eventType: raw,
        reason: raw,
      });
      recordNotificationRetryAttempt({ channel: raw, eventType: raw });
    }

    recordNotificationDelivered({
      channel: DeliveryChannel.EMAIL,
      eventType: EventType.REWARD_DISTRIBUTED,
      latencyMs: Number.NaN,
    });
    recordNotificationDelivered({
      channel: DeliveryChannel.EMAIL,
      eventType: EventType.REWARD_DISTRIBUTED,
      latencyMs: -5,
    });

    const scrape = await register.metrics();

    for (const pii of PII_INPUTS) {
      expect(scrape).not.toContain(pii);
    }
    expect(scrape).not.toContain('user@example.com');
    expect(scrape).not.toContain('0xde709f');
    expect(scrape).not.toContain('sk_live');

    const allowedChannels = new Set([
      ...CHANNEL_LABEL_VALUES,
      CHANNEL_LABEL_OTHER,
    ]);
    const allowedEventTypes = new Set([
      ...EVENT_TYPE_LABEL_VALUES,
      EVENT_TYPE_LABEL_OTHER,
    ]);
    const allowedReasons = new Set<string>(FAILURE_REASONS);

    const labelPattern = /channel="([^"]*)"/g;
    for (const match of scrape.matchAll(labelPattern)) {
      expect(allowedChannels.has(match[1])).toBe(true);
    }
    const eventTypePattern = /event_type="([^"]*)"/g;
    for (const match of scrape.matchAll(eventTypePattern)) {
      expect(allowedEventTypes.has(match[1])).toBe(true);
    }
    const reasonPattern = /reason="([^"]*)"/g;
    for (const match of scrape.matchAll(reasonPattern)) {
      expect(allowedReasons.has(match[1])).toBe(true);
    }

    const failedSeries = seriesValues(scrape, 'notifications_failed_total');
    expect(failedSeries.length).toBeLessThanOrEqual(
      (CHANNEL_LABEL_VALUES.length + 1) *
        (EVENT_TYPE_LABEL_VALUES.length + 1) *
        FAILURE_REASONS.length,
    );
    expect(failedSeries.length).toBeGreaterThan(0);
  });

  it('skips histogram observation for non-finite latency but still counts delivery', async () => {
    recordNotificationDelivered({
      channel: DeliveryChannel.EMAIL,
      eventType: EventType.REWARD_DISTRIBUTED,
      latencyMs: Number.NaN,
    });

    const scrape = await register.metrics();
    expect(scrape).toContain(
      'notifications_delivered_total{channel="email",event_type="REWARD_DISTRIBUTED"} 1',
    );
    expect(scrape).not.toContain(
      'notification_delivery_duration_seconds_count',
    );
  });

  it('records nothing when METRICS_ENABLED=false', async () => {
    process.env.METRICS_ENABLED = 'false';

    recordNotificationSent({
      channel: DeliveryChannel.EMAIL,
      eventType: EventType.CLAIM_CREATED,
    });
    recordNotificationDelivered({
      channel: DeliveryChannel.EMAIL,
      eventType: EventType.CLAIM_CREATED,
      latencyMs: 100,
    });
    recordNotificationFailed({
      channel: DeliveryChannel.EMAIL,
      eventType: EventType.CLAIM_CREATED,
      reason: 'timeout',
    });
    recordNotificationRetryAttempt({
      channel: DeliveryChannel.EMAIL,
      eventType: EventType.CLAIM_CREATED,
    });

    const scrape = await register.metrics();
    expect(scrape).not.toContain('notifications_sent_total');
    expect(scrape).not.toContain('notifications_delivered_total');
    expect(scrape).not.toContain('notifications_failed_total');
    expect(scrape).not.toContain('notifications_retried_total');
    expect(scrape).not.toContain('notification_delivery_duration_seconds');
  });

  it('treats METRICS_ENABLED=FALSE and " false " as disabled, but true as enabled', async () => {
    process.env.METRICS_ENABLED = 'FALSE';
    recordNotificationSent({
      channel: DeliveryChannel.EMAIL,
      eventType: EventType.CLAIM_CREATED,
    });
    expect(await register.metrics()).not.toContain('notifications_sent_total');

    register.clear();
    process.env.METRICS_ENABLED = ' false ';
    recordNotificationSent({
      channel: DeliveryChannel.EMAIL,
      eventType: EventType.CLAIM_CREATED,
    });
    expect(await register.metrics()).not.toContain('notifications_sent_total');

    register.clear();
    process.env.METRICS_ENABLED = 'true';
    recordNotificationSent({
      channel: DeliveryChannel.EMAIL,
      eventType: EventType.CLAIM_CREATED,
    });
    expect(await register.metrics()).toContain('notifications_sent_total');
  });
});

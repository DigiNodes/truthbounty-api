import {
  CHANNEL_LABEL_OTHER,
  CHANNEL_LABEL_VALUES,
  EVENT_TYPE_LABEL_OTHER,
  EVENT_TYPE_LABEL_VALUES,
  FAILURE_REASONS,
  toChannelLabel,
  toEventTypeLabel,
  toFailureReasonLabel,
} from './notification-metric-labels';
import { DeliveryChannel } from '../interfaces/notification.types';
import { EventType } from '../enums/event-type.enum';

const ADVERSARIAL_INPUTS = [
  'user@example.com',
  '0xde709f2102306220921060314715629080e2fb77',
  '0xAbCdEf0123456789abcdef0123456789ABCDEF01',
  'claim-3f2b7a91-8c4d-4e5f-9a0b-1c2d3e4f5a6b',
  'usr_1234567890',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
  'Bearer FAKE_CREDENTIAL_VALUE_FOR_TEST',
  'smtp://user:FAKE_PASSWORD_FOR_TEST@mail.example.com:587',
  'DROP TABLE notifications; --',
  'a'.repeat(500),
  '',
  '   ',
  null,
  undefined,
  42,
  { toString: () => 'user@example.com' },
];

describe('notification-metric-labels', () => {
  describe('toChannelLabel', () => {
    it('passes through every canonical DeliveryChannel value', () => {
      for (const channel of Object.values(DeliveryChannel)) {
        expect(toChannelLabel(channel)).toBe(channel);
      }
    });

    it.each(ADVERSARIAL_INPUTS)(
      'never emits raw input %p as a channel label',
      (input) => {
        const label = toChannelLabel(input);
        expect([...CHANNEL_LABEL_VALUES, CHANNEL_LABEL_OTHER]).toContain(label);
        if (
          typeof input !== 'string' ||
          !CHANNEL_LABEL_VALUES.includes(input)
        ) {
          expect(label).toBe(CHANNEL_LABEL_OTHER);
        }
      },
    );
  });

  describe('toEventTypeLabel', () => {
    it('passes through every canonical EventType value', () => {
      for (const eventType of Object.values(EventType)) {
        expect(toEventTypeLabel(eventType)).toBe(eventType);
      }
    });

    it.each(ADVERSARIAL_INPUTS)(
      'never emits raw input %p as an event type label',
      (input) => {
        const label = toEventTypeLabel(input);
        expect([...EVENT_TYPE_LABEL_VALUES, EVENT_TYPE_LABEL_OTHER]).toContain(
          label,
        );
        if (
          typeof input !== 'string' ||
          !EVENT_TYPE_LABEL_VALUES.includes(input)
        ) {
          expect(label).toBe(EVENT_TYPE_LABEL_OTHER);
        }
      },
    );
  });

  describe('toFailureReasonLabel', () => {
    const expectedMappings: Array<[string, string]> = [
      ['Request timed out after 30000ms', 'timeout'],
      ['ETIMEDOUT connecting to provider', 'timeout'],
      ['timed out waiting for SMTP', 'timeout'],
      ['Too Many Requests (429)', 'rate_limited'],
      ['rate limit exceeded for api key', 'rate_limited'],
      ['RateLimited by provider', 'rate_limited'],
      ['ECONNRESET socket hang up', 'network_error'],
      ['ENOTFOUND host mail.example.com', 'network_error'],
      ['network unreachable', 'network_error'],
      ['fetch failed', 'network_error'],
      ['HTTP 401 from provider', 'unauthorized'],
      ['403 forbidden for user', 'unauthorized'],
      ['unauthorized', 'unauthorized'],
      ['HTTP 404: template not found', 'not_found'],
      ['Notification endpoint not found', 'not_found'],
      ['HTTP 400 bad request', 'invalid_payload'],
      ['invalid payload: missing field', 'invalid_payload'],
      ['malformed JSON in template', 'invalid_payload'],
      ['failed to parse template', 'invalid_payload'],
      ['schema validation failed', 'invalid_payload'],
      ['HTTP 500 internal server error', 'provider_error'],
      ['SMTP connection refused by provider', 'provider_error'],
      ['502 bad gateway', 'provider_error'],
    ];

    it.each(expectedMappings)('maps %p to %p', (input, expected) => {
      expect(toFailureReasonLabel(input)).toBe(expected);
    });

    it.each(ADVERSARIAL_INPUTS)(
      'maps raw input %p to a closed-set reason without leaking it',
      (input) => {
        const label = toFailureReasonLabel(input);
        expect(FAILURE_REASONS).toContain(label);
        if (typeof input !== 'string' || input.length === 0) {
          expect(label).toBe('unknown');
        } else {
          expect(label).not.toBe(input);
          expect(label.length).toBeLessThan(32);
        }
      },
    );

    it('keeps the reason set bounded', () => {
      const sampled = new Set(
        ADVERSARIAL_INPUTS.map((input) => toFailureReasonLabel(input)),
      );
      for (const value of sampled) {
        expect(FAILURE_REASONS).toContain(value);
      }
      expect(sampled.size).toBeLessThanOrEqual(FAILURE_REASONS.length);
    });
  });
});

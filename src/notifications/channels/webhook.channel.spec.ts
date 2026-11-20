import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import { WebhookChannel } from './webhook.channel';
// PreferenceEnforcer is auto-mocked (see jest.mock below) so the channel's
// import of it resolves to a mock constructor used only as the DI token; the
// real module is never loaded, avoiding the unresolvable @nestjs/typeorm
// transitive dependency.
import { PreferenceEnforcer } from '../services/preference-enforcer.service';
import { DeliveryChannel } from '../interfaces/notification.types';
import { EventType } from '../enums/event-type.enum';
import type { RenderedNotificationPayload } from '../delivery/rendered-notification-payload';

// jest.mock is hoisted above the imports. A manual factory (rather than an
// automock) is used so the real module is never evaluated — an automock would
// load it to discover its exports, which would trigger the unresolvable
// @nestjs/typeorm transitive import. The returned class is used purely as the
// DI provider token.
jest.mock('../services/preference-enforcer.service', () => {
  return {
    PreferenceEnforcer: class MockPreferenceEnforcer {},
  };
});

/**
 * WebhookChannel SSRF hardening tests.
 *
 * Covers the redirect, signature-leak, delivery-time validation, and bounded
 * delivery scenarios that complement the unit tests in
 * `webhook-ssrf.guard.spec.ts`.
 */
describe('WebhookChannel SSRF hardening', () => {
  const basePayload: RenderedNotificationPayload = {
    userId: 'user-1',
    channel: DeliveryChannel.WEBHOOK,
    eventType: EventType.CLAIM_CREATED,
    rendered: { body: 'body', title: 't', subject: 's' },
    metadata: {},
  };

  async function buildChannel(opts: {
    preferences: Record<string, unknown>;
    post?: jest.Mock;
  }): Promise<{ channel: WebhookChannel; httpService: { post: jest.Mock } }> {
    const httpService = {
      post:
        opts.post ?? jest.fn(() => of({ status: 200, data: {}, headers: {} })),
    };
    const preferenceEnforcer = {
      getPreferences: jest.fn(async () => opts.preferences),
      isChannelEnabled: jest.fn(async () => true),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WebhookChannel,
        { provide: ConfigService, useValue: new ConfigService() },
        { provide: PreferenceEnforcer, useValue: preferenceEnforcer },
        { provide: HttpService, useValue: httpService },
      ],
    }).compile();

    return { channel: moduleRef.get(WebhookChannel), httpService };
  }

  // -------------------------------------------------------------------------
  // Delivery-time destination validation
  // -------------------------------------------------------------------------
  describe('delivery-time validation', () => {
    it('rejects a loopback IP at delivery time and never sends the request', async () => {
      const { channel, httpService } = await buildChannel({
        preferences: {
          webhookConfig: { url: 'https://127.0.0.1/', secret: 's3cret' },
        },
      });

      const result = await channel.send(basePayload);

      expect(result.success).toBe(false);
      expect(httpService.post).not.toHaveBeenCalled();
    });

    it('rejects a cloud metadata IP at delivery time', async () => {
      const { channel, httpService } = await buildChannel({
        preferences: { webhookConfig: { url: 'https://169.254.169.254/' } },
      });

      const result = await channel.send(basePayload);

      expect(result.success).toBe(false);
      expect(httpService.post).not.toHaveBeenCalled();
    });

    it('rejects a non-https URL when https is required', async () => {
      const { channel, httpService } = await buildChannel({
        preferences: { webhookConfig: { url: 'http://8.8.8.8/' } },
      });

      const result = await channel.send(basePayload);

      expect(result.success).toBe(false);
      expect(httpService.post).not.toHaveBeenCalled();
    });

    it('returns failure when no webhook is configured', async () => {
      const { channel, httpService } = await buildChannel({
        preferences: { webhookConfig: null },
      });

      const result = await channel.send(basePayload);

      expect(result.success).toBe(false);
      expect(result.error).toContain('no webhook');
      expect(httpService.post).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Event filtering (no network when filtered out)
  // -------------------------------------------------------------------------
  it('skips delivery for events not in the webhook filter without sending', async () => {
    const { channel, httpService } = await buildChannel({
      preferences: {
        webhookConfig: { url: 'https://8.8.8.8/', events: ['OTHER_EVENT'] },
      },
    });

    const result = await channel.send(basePayload);

    expect(result.success).toBe(true);
    expect(httpService.post).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Redirect handling & signature leak prevention
  // -------------------------------------------------------------------------
  describe('redirects', () => {
    it('rejects a 301 redirect and does not follow it', async () => {
      const { channel, httpService } = await buildChannel({
        preferences: {
          webhookConfig: { url: 'https://8.8.8.8/', secret: 's3cret' },
        },
        post: jest.fn(() =>
          of({
            status: 301,
            headers: { location: 'https://169.254.169.254/' },
            data: '',
          }),
        ),
      });

      const result = await channel.send(basePayload);

      expect(result.success).toBe(false);
      expect(result.error).toContain('redirect');
      // Exactly one request — to the validated destination only.
      expect(httpService.post).toHaveBeenCalledTimes(1);
    });

    it('never forwards the HMAC signature to a redirected host', async () => {
      // The POST is intercepted (mocked) so only one call is ever made — to the
      // validated destination. There is no second call carrying the signature.
      const { channel, httpService } = await buildChannel({
        preferences: {
          webhookConfig: { url: 'https://8.8.8.8/', secret: 'topsecret' },
        },
        post: jest.fn(() =>
          of({
            status: 302,
            headers: { location: 'https://internal.evil/' },
            data: '',
          }),
        ),
      });

      await channel.send(basePayload);

      expect(httpService.post).toHaveBeenCalledTimes(1);
      const [, , config] = httpService.post.mock.calls[0];
      // The single call carries the signature, but it went only to the validated
      // destination (8.8.8.8), never to the redirect target.
      expect(config.headers['X-Webhook-Signature']).toMatch(/^sha256=/);
      expect(config.maxRedirects).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Bounded public HTTPS delivery
  // -------------------------------------------------------------------------
  describe('bounded public HTTPS delivery', () => {
    it('succeeds for a public destination and applies bounded timeouts / size / redirect policy', async () => {
      const { channel, httpService } = await buildChannel({
        preferences: {
          webhookConfig: { url: 'https://8.8.8.8/', secret: 's3cret' },
        },
      });

      const result = await channel.send(basePayload);

      expect(result.success).toBe(true);
      expect(httpService.post).toHaveBeenCalledTimes(1);

      const [url, body, config] = httpService.post.mock.calls[0];
      expect(url).toBe('https://8.8.8.8/');
      // Redirects disabled.
      expect(config.maxRedirects).toBe(0);
      // Response body and request body are bounded.
      expect(config.maxContentLength).toBeGreaterThan(0);
      expect(config.maxBodyLength).toBeGreaterThan(0);
      // Overall timeout applied.
      expect(config.timeout).toBeGreaterThan(0);
      // A validating agent is attached for HTTPS egress, with the DNS-rebinding
      // lookup wired in (Node stores it under agent.options.lookup).
      expect(config.httpsAgent).toBeDefined();
      expect(typeof config.httpsAgent.options?.lookup).toBe('function');
      // Payload is minimal (no secrets leak into the body).
      expect(body).not.toHaveProperty('secret');
    });

    it('includes the HMAC signature header when a secret is configured', async () => {
      const { channel, httpService } = await buildChannel({
        preferences: {
          webhookConfig: { url: 'https://8.8.8.8/', secret: 's3cret' },
        },
      });

      await channel.send(basePayload);

      const [, , config] = httpService.post.mock.calls[0];
      expect(config.headers['X-Webhook-Signature']).toMatch(/^sha256=/);
    });

    it('omits the signature header when no secret is configured', async () => {
      const { channel, httpService } = await buildChannel({
        preferences: { webhookConfig: { url: 'https://8.8.8.8/' } },
      });

      await channel.send(basePayload);

      const [, , config] = httpService.post.mock.calls[0];
      expect(config.headers['X-Webhook-Signature']).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // validateConfig uses the shared SSRF policy
  // -------------------------------------------------------------------------
  describe('validateConfig', () => {
    it('rejects a private IP config', async () => {
      const { channel } = await buildChannel({
        preferences: { webhookConfig: { url: 'https://10.0.0.5/' } },
      });

      const result = await channel.validateConfig('user-1');

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('accepts a public destination config', async () => {
      const { channel } = await buildChannel({
        preferences: { webhookConfig: { url: 'https://8.8.8.8/' } },
      });

      const result = await channel.validateConfig('user-1');

      expect(result.valid).toBe(true);
    });

    it('reports no webhook configured', async () => {
      const { channel } = await buildChannel({
        preferences: { webhookConfig: null },
      });

      const result = await channel.validateConfig('user-1');

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('No webhook');
    });
  });
});

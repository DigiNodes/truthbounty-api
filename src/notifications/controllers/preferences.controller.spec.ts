import { Logger } from '@nestjs/common';
import { PreferencesController } from './preferences.controller';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { PatchPreferencesDto } from '../dto/patch-preferences.dto';

const SECRET = 'canary-webhook-signing-secret';

function preference(overrides: Partial<NotificationPreference> = {}): NotificationPreference {
  return {
    id: 'pref-1',
    userId: 'user-1',
    channels: { in_app: true },
    categorySubscriptions: {},
    language: 'en',
    webhookConfig: {
      url: 'https://hooks.example.com/webhook',
      secret: SECRET,
      events: ['claim.created'],
    },
    unsubscribeToken: 'unsubscribe-token-should-not-be-returned',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as NotificationPreference;
}

describe('PreferencesController secret redaction (PREWAVE-BE-169)', () => {
  let enforcer: {
    getPreferences: jest.Mock;
    updatePreferences: jest.Mock;
  };
  let webhooks: {
    configureWebhook: jest.Mock;
    rotateSecret: jest.Mock;
    removeWebhook: jest.Mock;
  };
  let controller: PreferencesController;

  beforeEach(() => {
    enforcer = {
      getPreferences: jest.fn(async () => preference()),
      updatePreferences: jest.fn(async () => preference()),
    };
    webhooks = {
      configureWebhook: jest.fn(async () => preference()),
      rotateSecret: jest.fn(async () => preference()),
      removeWebhook: jest.fn(async () => preference()),
    };
    controller = new PreferencesController(enforcer as never, webhooks as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('never returns the raw secret or unsubscribe token from GET', async () => {
    const result = await controller.getPreferences('user-1');
    expect(result.webhookConfig).toEqual({
      url: 'https://hooks.example.com/webhook',
      events: ['claim.created'],
      secretConfigured: true,
      retryAttempts: undefined,
      timeout: undefined,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain('unsubscribe-token-should-not-be-returned');
    expect((result as unknown as Record<string, unknown>).webhookConfig).not.toHaveProperty(
      'secret',
    );
  });

  it('exposes only secretConfigured when configuring a webhook', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    const result = await controller.setWebhook('user-1', {
      url: 'https://hooks.example.com/webhook',
      secret: SECRET,
      events: ['claim.created'],
    });

    expect(webhooks.configureWebhook).toHaveBeenCalledTimes(1);
    expect(result.webhookConfig?.secretConfigured).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(debug.mock.calls.map((call) => JSON.stringify(call)).join('\n')).not.toContain(SECRET);
  });

  it('does not log the PATCH body, even if a caller supplies a secret', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    // Simulate a client bypassing DTO validation with a nested secret.
    const updates = {
      language: 'fr',
      webhookConfig: { secret: SECRET },
    } as unknown as PatchPreferencesDto;
    const result = await controller.updatePreferences('user-1', updates);

    const logged = debug.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(logged).not.toContain(SECRET);
    expect(logged).toContain('language');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('returns safe responses from every mutating endpoint', async () => {
    const responses = await Promise.all([
      controller.enableChannel('user-1', 'email'),
      controller.disableChannel('user-1', 'email'),
      controller.setQuietHours('user-1', { enabled: true }),
      controller.disableQuietHours('user-1'),
      controller.setDigestPreferences('user-1', { enabled: true }),
      controller.updateEmail('user-1', { email: 'user@example.com' }),
      controller.rotateWebhookSecret('user-1', { secret: SECRET }),
      controller.removeWebhook('user-1'),
      controller.subscribeToEvent('user-1', 'claim.created'),
      controller.unsubscribeFromEvent('user-1', 'claim.created'),
    ]);

    for (const response of responses) {
      expect(JSON.stringify(response)).not.toContain(SECRET);
      expect((response as unknown as Record<string, unknown>).webhookConfig).not.toHaveProperty(
        'secret',
      );
    }
  });

  it('reports secretConfigured=false when no secret is stored', async () => {
    enforcer.getPreferences.mockResolvedValue(
      preference({ webhookConfig: { url: 'https://hooks.example.com/webhook' } }),
    );
    const result = await controller.getPreferences('user-1');
    expect(result.webhookConfig?.secretConfigured).toBe(false);
  });
});

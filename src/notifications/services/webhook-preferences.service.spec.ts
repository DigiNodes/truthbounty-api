import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookPreferencesService } from './webhook-preferences.service';
import { WebhookSecretCipher } from './webhook-secret-cipher.service';
import { NotificationPreference } from '../entities/notification-preference.entity';

const ciphertextKey = Buffer.from('c'.repeat(32), 'utf8').toString('base64url');
const SECRET = 'canary-signing-secret';

function makePreference(overrides: Partial<NotificationPreference> = {}): NotificationPreference {
  return {
    id: 'pref-1',
    userId: 'user-1',
    channels: {},
    categorySubscriptions: {},
    language: 'en',
    webhookConfig: null,
    ...overrides,
  } as NotificationPreference;
}

describe('WebhookPreferencesService (PREWAVE-BE-169)', () => {
  let repo: { save: jest.Mock };
  let enforcer: { getPreferences: jest.Mock };
  let cipher: WebhookSecretCipher;
  let audit: { log: jest.Mock };
  let service: WebhookPreferencesService;

  beforeEach(() => {
    repo = { save: jest.fn(async (pref: NotificationPreference) => pref) };
    enforcer = { getPreferences: jest.fn(async () => makePreference()) };
    const configService = {
      get: jest.fn((key: string) =>
        key === 'WEBHOOK_SECRET_KEY' ? ciphertextKey : undefined,
      ),
    } as unknown as ConfigService;
    cipher = new WebhookSecretCipher(configService);
    audit = { log: jest.fn(async () => undefined) };
    service = new WebhookPreferencesService(
      repo as never,
      enforcer as never,
      cipher,
      audit as never,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('stores the secret encrypted and returns no secret material', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    const saved = await service.configureWebhook('user-1', {
      url: 'https://hooks.example.com/webhook',
      secret: SECRET,
      events: ['claim.created'],
    });

    expect(saved.webhookConfig?.secret).toBeDefined();
    expect(saved.webhookConfig?.secret).not.toBe(SECRET);
    expect(cipher.decrypt(saved.webhookConfig!.secret!)).toBe(SECRET);

    const persisted = JSON.stringify(repo.save.mock.calls[0][0]);
    expect(persisted).not.toContain(SECRET);
    expect(JSON.stringify(audit.log.mock.calls[0][0])).not.toContain(SECRET);
    expect(debug.mock.calls.map((call) => JSON.stringify(call)).join('\n')).not.toContain(SECRET);
  });

  it('preserves the existing encrypted secret when an update omits it', async () => {
    const encrypted = cipher.encrypt(SECRET);
    enforcer.getPreferences.mockResolvedValue(
      makePreference({
        webhookConfig: { url: 'https://hooks.example.com/webhook', secret: encrypted, events: ['a'] },
      }),
    );

    const saved = await service.configureWebhook('user-1', {
      url: 'https://hooks.example.com/new-path',
      events: ['b'],
    });

    expect(saved.webhookConfig?.secret).toBe(encrypted);
    expect(saved.webhookConfig?.url).toBe('https://hooks.example.com/new-path');
    expect(saved.webhookConfig?.events).toEqual(['b']);
  });

  it('rotates the secret atomically and invalidates the previous value', async () => {
    const encrypted = cipher.encrypt(SECRET);
    enforcer.getPreferences.mockResolvedValue(
      makePreference({
        webhookConfig: { url: 'https://hooks.example.com/webhook', secret: encrypted, events: ['a'] },
      }),
    );

    const replacement = 'brand-new-signing-secret';
    const saved = await service.rotateSecret('user-1', { secret: replacement });

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(saved.webhookConfig?.secret).not.toBe(encrypted);
    expect(cipher.decrypt(saved.webhookConfig!.secret!)).toBe(replacement);
    expect(audit.log.mock.calls[0][0].metadata.secretRotated).toBe(true);
    expect(JSON.stringify(audit.log.mock.calls[0][0])).not.toContain(replacement);
    expect(JSON.stringify(audit.log.mock.calls[0][0])).not.toContain(SECRET);
  });

  it('rejects rotation when no webhook is configured', async () => {
    await expect(service.rotateSecret('user-1', { secret: SECRET })).rejects.toThrow(
      'No webhook is configured',
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('removes the webhook configuration and its secret', async () => {
    enforcer.getPreferences.mockResolvedValue(
      makePreference({
        webhookConfig: {
          url: 'https://hooks.example.com/webhook',
          secret: cipher.encrypt(SECRET),
        },
      }),
    );
    const saved = await service.removeWebhook('user-1');
    expect(saved.webhookConfig).toBeNull();
    expect(JSON.stringify(audit.log.mock.calls[0][0])).not.toContain(SECRET);
  });

  it('blocks SSRF destinations with a generic error message', async () => {
    await expect(
      service.configureWebhook('user-1', {
        url: 'http://127.0.0.1:8080/hook',
        secret: SECRET,
      }),
    ).rejects.toThrow('Webhook URL is not allowed');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('resolves the plaintext only for signature generation', () => {
    const encrypted = cipher.encrypt(SECRET);
    expect(service.resolveSigningSecret(encrypted)).toBe(SECRET);
    expect(service.resolveSigningSecret(undefined)).toBeNull();
  });
});

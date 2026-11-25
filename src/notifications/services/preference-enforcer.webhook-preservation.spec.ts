import { PreferenceEnforcer } from './preference-enforcer.service';
import { NotificationPreference } from '../entities/notification-preference.entity';

/**
 * Regression coverage for #849/#872: a generic preference update must not
 * mass-assign webhookConfig (and therefore cannot overwrite or echo a secret).
 */
describe('PreferenceEnforcer generic updates preserve webhook secrets', () => {
  it('ignores caller-provided webhookConfig and identity fields', async () => {
    const encrypted = 'whsec1.encrypted-value-that-must-remain';
    const stored = {
      id: 'pref-1',
      userId: 'user-1',
      language: 'en',
      channels: { in_app: true },
      webhookConfig: { url: 'https://hooks.example.com', secret: encrypted },
      unsubscribeToken: 'real-token',
    } as NotificationPreference;

    const repo = {
      findOne: jest.fn(async () => stored),
      create: jest.fn(),
      save: jest.fn(async (pref: NotificationPreference) => pref),
    };
    const service = new PreferenceEnforcer(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const saved = await service.updatePreferences('user-1', {
      language: 'fr',
      userId: 'attacker',
      id: 'attacker-id',
      unsubscribeToken: 'attacker-token',
      webhookConfig: { url: 'https://attacker.example.com', secret: 'raw-secret' },
    } as unknown as Partial<NotificationPreference>);

    expect(saved.language).toBe('fr');
    expect(saved.userId).toBe('user-1');
    expect(saved.id).toBe('pref-1');
    expect(saved.unsubscribeToken).toBe('real-token');
    expect(saved.webhookConfig).toEqual({
      url: 'https://hooks.example.com',
      secret: encrypted,
    });
    expect(JSON.stringify(repo.save.mock.calls[0][0])).not.toContain('raw-secret');
  });
});

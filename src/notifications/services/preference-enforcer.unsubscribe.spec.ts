import { PreferenceEnforcer } from './preference-enforcer.service';
import { UnsubscribeTokenService } from './unsubscribe-token.service';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { DeliveryChannel } from '../interfaces/notification.types';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';

describe('PreferenceEnforcer Unsubscribe via Signed Tokens (PREWAVE-BE-199 / #798)', () => {
  let enforcer: PreferenceEnforcer;
  let tokenService: UnsubscribeTokenService;
  let mockPreferenceRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let storedPreferences: Map<string, NotificationPreference>;

  beforeEach(() => {
    storedPreferences = new Map<string, NotificationPreference>();

    const mockConfig = {
      get: jest.fn((key: string, defaultValue?: any) => {
        if (key === 'JWT_SECRET' || key === 'UNSUBSCRIBE_TOKEN_SECRET') {
          return 'super-secret-key-at-least-32-chars-long-for-testing!';
        }
        return defaultValue;
      }),
    } as unknown as ConfigService;

    tokenService = new UnsubscribeTokenService(mockConfig, undefined);

    mockPreferenceRepo = {
      findOne: jest.fn(async ({ where }: { where: any }) => {
        if (where.userId) {
          return storedPreferences.get(where.userId) || null;
        }
        if (where.unsubscribeToken) {
          for (const pref of storedPreferences.values()) {
            if (pref.unsubscribeToken === where.unsubscribeToken) return pref;
          }
        }
        return null;
      }),
      create: jest.fn((data: any) => ({ ...data, id: 'pref-id-generated' })),
      save: jest.fn(async (pref: NotificationPreference) => {
        storedPreferences.set(pref.userId, { ...pref });
        return pref;
      }),
    };

    enforcer = new PreferenceEnforcer(
      mockPreferenceRepo as any,
      {} as any,
      {} as any,
      {} as any,
      tokenService,
    );
  });

  function seedUserPreferences(
    userId: string,
    channels: Partial<Record<DeliveryChannel, boolean>> = {},
  ): NotificationPreference {
    const pref = {
      id: `pref-${userId}`,
      userId,
      channels: {
        [DeliveryChannel.IN_APP]: true,
        [DeliveryChannel.EMAIL]: true,
        [DeliveryChannel.PUSH]: true,
        [DeliveryChannel.WEBHOOK]: false,
        [DeliveryChannel.WEBSOCKET]: true,
        [DeliveryChannel.SMS]: false,
        ...channels,
      },
      categorySubscriptions: {},
      language: 'en',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as NotificationPreference;
    storedPreferences.set(userId, pref);
    return pref;
  }

  describe('Channel isolation and targeted unsubscribe', () => {
    it('only disables the intended channel (EMAIL) and leaves all other channels intact', async () => {
      seedUserPreferences('user-alpha', {
        [DeliveryChannel.IN_APP]: true,
        [DeliveryChannel.EMAIL]: true,
        [DeliveryChannel.PUSH]: true,
        [DeliveryChannel.WEBSOCKET]: true,
      });

      const token = tokenService.generateToken({
        userId: 'user-alpha',
        channel: DeliveryChannel.EMAIL,
      });

      const success = await enforcer.unsubscribeViaToken(token);
      expect(success).toBe(true);

      const updated = storedPreferences.get('user-alpha')!;
      expect(updated.channels[DeliveryChannel.EMAIL]).toBe(false);
      // Verify other channels were not disabled
      expect(updated.channels[DeliveryChannel.IN_APP]).toBe(true);
      expect(updated.channels[DeliveryChannel.PUSH]).toBe(true);
      expect(updated.channels[DeliveryChannel.WEBSOCKET]).toBe(true);
    });
  });

  describe('Single-use and replay enforcement', () => {
    it('consumes token successfully once and rejects subsequent replays', async () => {
      seedUserPreferences('user-beta');
      const token = tokenService.generateToken({
        userId: 'user-beta',
        channel: DeliveryChannel.EMAIL,
      });

      // First use succeeds
      const firstResult = await enforcer.unsubscribeViaToken(token);
      expect(firstResult).toBe(true);

      // Second use of the exact same token fails closed (replay prevention)
      const secondResult = await enforcer.unsubscribeViaToken(token);
      expect(secondResult).toBe(false);
    });
  });

  describe('Duplicate unsubscribe and idempotency', () => {
    it('handles idempotent unsubscription safely when user is already unsubscribed', async () => {
      // User has already turned off email
      seedUserPreferences('user-gamma', {
        [DeliveryChannel.EMAIL]: false,
        [DeliveryChannel.IN_APP]: true,
      });

      const token = tokenService.generateToken({
        userId: 'user-gamma',
        channel: DeliveryChannel.EMAIL,
      });

      const result = await enforcer.unsubscribeViaToken(token);
      expect(result).toBe(true);

      const pref = storedPreferences.get('user-gamma')!;
      expect(pref.channels[DeliveryChannel.EMAIL]).toBe(false);
      expect(pref.channels[DeliveryChannel.IN_APP]).toBe(true);
    });
  });

  describe('Cross-user substitution defense', () => {
    it('never unsubscribes a different user when given a token issued to another principal', async () => {
      seedUserPreferences('alice');
      seedUserPreferences('bob');

      const aliceToken = tokenService.generateToken({
        userId: 'alice',
        channel: DeliveryChannel.EMAIL,
      });

      // isUnsubscribed check with wrong user returns false
      const bobCheck = await enforcer.isUnsubscribed('bob', aliceToken);
      expect(bobCheck).toBe(false);

      // Consuming alice's token only mutates alice, never bob
      await enforcer.unsubscribeViaToken(aliceToken);
      expect(storedPreferences.get('alice')!.channels[DeliveryChannel.EMAIL]).toBe(false);
      expect(storedPreferences.get('bob')!.channels[DeliveryChannel.EMAIL]).toBe(true);
    });
  });

  describe('Tampering and expired token defense', () => {
    it('fails closed on tampered token without modifying any user preferences', async () => {
      seedUserPreferences('victim-user');
      const token = tokenService.generateToken({ userId: 'victim-user' });
      const tampered = token.slice(0, -4) + 'AAAA';

      const success = await enforcer.unsubscribeViaToken(tampered);
      expect(success).toBe(false);
      expect(storedPreferences.get('victim-user')!.channels[DeliveryChannel.EMAIL]).toBe(true);
    });

    it('fails closed on expired token', async () => {
      seedUserPreferences('expired-user');
      const expiredToken = tokenService.generateToken({
        userId: 'expired-user',
        ttlSeconds: -100,
      });

      const success = await enforcer.unsubscribeViaToken(expiredToken);
      expect(success).toBe(false);
      expect(storedPreferences.get('expired-user')!.channels[DeliveryChannel.EMAIL]).toBe(true);
    });
  });

  describe('Logging security', () => {
    it('never prints the raw token in log output', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      seedUserPreferences('logged-user');
      const token = tokenService.generateToken({ userId: 'logged-user' });
      await enforcer.unsubscribeViaToken(token);

      const allOutput = [
        ...logSpy.mock.calls.map((c) => c.join(' ')),
        ...warnSpy.mock.calls.map((c) => c.join(' ')),
      ].join('\n');

      expect(allOutput).not.toContain(token);

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });
});

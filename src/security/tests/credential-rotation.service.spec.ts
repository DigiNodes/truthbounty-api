import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import {
  CredentialRotationService,
  CredentialDomain,
} from '../credential-rotation.service';
import { RedisService } from '../../redis/redis.service';

// ── helpers ───────────────────────────────────────────────────────────────────

/** A secret that meets the 32-character minimum. */
const strongSecret = (suffix = '1') =>
  `a-cryptographically-strong-secret-value-${suffix}`.padEnd(32, '0');

const DOMAINS: CredentialDomain[] = [
  'siwe',
  'webhook',
  'encryption',
  'provider',
  'database',
];

function domainEnvKey(domain: CredentialDomain): string {
  return `${domain.toUpperCase()}_SECRET`;
}

/** Build a ConfigService mock that returns a strong secret for every domain. */
function makeConfigMock(
  overrides: Partial<Record<string, string>> = {},
): jest.Mocked<Pick<ConfigService, 'get'>> {
  return {
    get: jest.fn((key: string) => {
      if (key in overrides) return overrides[key];
      // Return a valid strong secret for each domain by default.
      for (const d of DOMAINS) {
        if (key === domainEnvKey(d)) return strongSecret(d);
      }
      return undefined;
    }),
  } as any;
}

/** Build a RedisService mock that simulates in-memory get/set. */
function makeRedisMock(): jest.Mocked<
  Pick<RedisService, 'get' | 'set' | 'del'>
> {
  const store = new Map<string, string>();
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return true;
    }),
    del: jest.fn(async (key: string) => {
      store.delete(key);
      return true;
    }),
  } as any;
}

async function buildService(
  configOverrides: Partial<Record<string, string>> = {},
  redisMock?: ReturnType<typeof makeRedisMock>,
): Promise<CredentialRotationService> {
  const redis = redisMock ?? makeRedisMock();
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      CredentialRotationService,
      { provide: ConfigService, useValue: makeConfigMock(configOverrides) },
      { provide: RedisService, useValue: redis },
    ],
  }).compile();

  const svc = module.get<CredentialRotationService>(CredentialRotationService);
  await svc.onModuleInit();
  return svc;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('CredentialRotationService', () => {
  // ── Startup / initialization ────────────────────────────────────────────

  describe('Startup validation', () => {
    it('initializes all five domains when all secrets are provisioned', async () => {
      const svc = await buildService();
      for (const domain of DOMAINS) {
        const status: any = svc.getStatus(domain);
        expect(status.activeKeyId).toBe(`${domain}-v1`);
        expect(status.totalKeys).toBe(1);
        expect(status.hasOverlap).toBe(false);
      }
    });

    it('fails startup when a required domain secret is absent', async () => {
      await expect(
        buildService({ SIWE_SECRET: undefined as any }),
      ).rejects.toThrow(/SIWE_SECRET is not set/);
    });

    it('fails startup when a domain secret is an empty string', async () => {
      await expect(buildService({ WEBHOOK_SECRET: '' })).rejects.toThrow(
        /WEBHOOK_SECRET is not set/,
      );
    });

    it('fails startup when a domain secret is shorter than 32 characters', async () => {
      await expect(
        buildService({ ENCRYPTION_SECRET: 'short' }),
      ).rejects.toThrow(/too short/);
    });

    it('fails startup for every domain independently', async () => {
      for (const domain of DOMAINS) {
        const key = domainEnvKey(domain);
        await expect(buildService({ [key]: '' })).rejects.toThrow();
      }
    });
  });

  // ── No Math.random() fallback ───────────────────────────────────────────

  describe('No weak or hard-coded fallback secret', () => {
    it('never uses Math.random() — the original spy must not be called during init', async () => {
      const spy = jest.spyOn(Math, 'random');
      await buildService();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('does not silently generate a replacement secret at startup', async () => {
      // With a missing secret, the service must throw, not substitute a value.
      await expect(
        buildService({ SIWE_SECRET: undefined as any }),
      ).rejects.toThrow();
    });
  });

  // ── Rotation ────────────────────────────────────────────────────────────

  describe('rotateCredential', () => {
    it('promotes the new key to active and demotes the old to overlap', async () => {
      const svc = await buildService();
      const result = await svc.rotateCredential(
        'webhook',
        'webhook-v2',
        strongSecret('v2'),
        60_000,
      );
      expect(result.activeKeyId).toBe('webhook-v2');
      expect(result.previousKeyId).toBe('webhook-v1');

      const status: any = svc.getStatus('webhook');
      expect(status.activeKeyId).toBe('webhook-v2');
      expect(status.previousKeyId).toBe('webhook-v1');
      expect(status.hasOverlap).toBe(true);
    });

    it('allows the previous key to be retrieved during the overlap window', async () => {
      const svc = await buildService();
      await svc.rotateCredential('siwe', 'siwe-v2', strongSecret('v2'), 60_000);
      expect(() => svc.getSecret('siwe', 'siwe-v1')).not.toThrow();
      expect(() => svc.getSecret('siwe', 'siwe-v2')).not.toThrow();
    });

    it('throws BadRequestException when rotating to a revoked key ID', async () => {
      const svc = await buildService();
      await svc.rotateCredential('provider', 'provider-v2', strongSecret('v2'));
      await svc.revokeKey('provider', 'provider-v2');
      await expect(
        svc.rotateCredential('provider', 'provider-v2', strongSecret('v2b')),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws when key ID or secret is empty', async () => {
      const svc = await buildService();
      await expect(
        svc.rotateCredential('siwe', '', strongSecret()),
      ).rejects.toThrow(BadRequestException);
      await expect(
        svc.rotateCredential('siwe', 'siwe-v2', ''),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── Rollback ─────────────────────────────────────────────────────────────

  describe('rollbackCredential', () => {
    it('restores the previous key as active', async () => {
      const svc = await buildService();
      await svc.rotateCredential('siwe', 'siwe-v2', strongSecret('v2'));
      const result = await svc.rollbackCredential('siwe');
      expect(result.activeKeyId).toBe('siwe-v1');
      expect(result.rolledBackFrom).toBe('siwe-v2');
    });

    it('throws when no rollback target exists', async () => {
      const svc = await buildService();
      await expect(svc.rollbackCredential('siwe')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws when rollback target is revoked', async () => {
      const svc = await buildService();
      await svc.rotateCredential('webhook', 'webhook-v2', strongSecret('v2'));
      await svc.revokeKey('webhook', 'webhook-v1');
      await expect(svc.rollbackCredential('webhook')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── Revocation ────────────────────────────────────────────────────────────

  describe('revokeKey', () => {
    it('rejects revoked keys immediately', async () => {
      const svc = await buildService();
      await svc.rotateCredential('encryption', 'enc-v2', strongSecret('v2'));
      await svc.revokeKey('encryption', 'enc-v1');
      expect(() => svc.getSecret('encryption', 'enc-v1')).toThrow(
        UnauthorizedException,
      );
    });

    it('fails closed when the active key is revoked', async () => {
      const svc = await buildService();
      await svc.revokeKey('database', 'database-v1');
      expect(() => svc.getSecret('database')).toThrow(UnauthorizedException);
    });

    it('throws for an unknown key ID', async () => {
      const svc = await buildService();
      await expect(
        svc.revokeKey('siwe', 'siwe-does-not-exist'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── Expiry ────────────────────────────────────────────────────────────────

  describe('Expired overlap window', () => {
    it('fails closed when the overlap window has passed', async () => {
      const svc = await buildService();
      await svc.rotateCredential('encryption', 'enc-v2', strongSecret('v2'), 1);

      const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
      expect(() => svc.getSecret('encryption', 'enc-v1')).toThrow(
        UnauthorizedException,
      );
      spy.mockRestore();
    });
  });

  // ── Unknown key ID ────────────────────────────────────────────────────────

  describe('Unknown key ID', () => {
    it('fails closed for an entirely unknown key ID', async () => {
      const svc = await buildService();
      expect(() => svc.getSecret('provider', 'provider-unknown-999')).toThrow(
        UnauthorizedException,
      );
    });
  });

  // ── Durable state — survives restart ─────────────────────────────────────

  describe('Rotation state survives restart', () => {
    it('restores active key ID and overlap state from Redis after restart', async () => {
      const redis = makeRedisMock();

      // First "instance" — rotates the credential.
      const svc1 = await buildService({}, redis);
      await svc1.rotateCredential('siwe', 'siwe-v2', strongSecret('v2'), 60_000);

      // Second "instance" — simulates a restart using the same Redis store.
      const svc2 = await buildService({}, redis);
      const status: any = svc2.getStatus('siwe');
      expect(status.activeKeyId).toBe('siwe-v2');
      expect(status.previousKeyId).toBe('siwe-v1');
      expect(status.hasOverlap).toBe(true);
    });

    it('restores revocation state from Redis after restart', async () => {
      const redis = makeRedisMock();

      const svc1 = await buildService({}, redis);
      await svc1.rotateCredential('webhook', 'webhook-v2', strongSecret('v2'));
      await svc1.revokeKey('webhook', 'webhook-v1');

      const svc2 = await buildService({}, redis);
      // The revoked key must still be rejected on the second instance.
      expect(() => svc2.getSecret('webhook', 'webhook-v1')).toThrow(
        UnauthorizedException,
      );
    });
  });

  // ── Consistency across replicas ───────────────────────────────────────────

  describe('State is shared across replicas', () => {
    it('two instances using the same Redis see the same active key', async () => {
      const redis = makeRedisMock();

      const replica1 = await buildService({}, redis);
      await replica1.rotateCredential('provider', 'prov-v2', strongSecret('v2'));

      const replica2 = await buildService({}, redis);
      const r1Status: any = replica1.getStatus('provider');
      const r2Status: any = replica2.getStatus('provider');

      expect(r1Status.activeKeyId).toBe('prov-v2');
      expect(r2Status.activeKeyId).toBe('prov-v2');
    });
  });

  // ── Secrets never appear in status / logs / errors ────────────────────────

  describe('Secret material never exposed', () => {
    it('status view does not contain any secret material', async () => {
      const svc = await buildService();
      const status: any = svc.getStatus('siwe');
      const json = JSON.stringify(status);
      expect(status).not.toHaveProperty('secret');
      expect(json).not.toMatch(/secret/i);
    });

    it('all-domain status view does not leak secrets', async () => {
      const svc = await buildService();
      const statuses = svc.getStatus() as any[];
      const json = JSON.stringify(statuses);
      for (const s of statuses) {
        expect(s).not.toHaveProperty('secret');
      }
      expect(json).not.toMatch(/a-cryptographically/);
    });

    it('error thrown by getSecret does not contain the secret value', async () => {
      const svc = await buildService();
      await svc.revokeKey('siwe', 'siwe-v1');
      try {
        svc.getSecret('siwe', 'siwe-v1');
        fail('expected to throw');
      } catch (err: any) {
        expect(err.message).not.toContain(strongSecret('siwe'));
      }
    });

    it('rotateCredential result does not contain secret material', async () => {
      const svc = await buildService();
      const result = await svc.rotateCredential(
        'webhook',
        'webhook-v2',
        strongSecret('v2'),
      );
      const json = JSON.stringify(result);
      expect(json).not.toContain(strongSecret('v2'));
    });
  });

  // ── Concurrent rotation ───────────────────────────────────────────────────

  describe('Concurrent rotation', () => {
    it('handles concurrent rotations without leaving state undefined', async () => {
      const svc = await buildService();
      await Promise.all([
        svc.rotateCredential('database', 'db-v2', strongSecret('v2')),
        svc.rotateCredential('database', 'db-v3', strongSecret('v3')),
      ]);
      const status: any = svc.getStatus('database');
      expect(['db-v2', 'db-v3']).toContain(status.activeKeyId);
      expect(status.totalKeys).toBe(3);
    });
  });

  // ── Redis persistence failure ─────────────────────────────────────────────

  describe('Redis persistence failure', () => {
    it('continues in-memory operation when Redis set fails', async () => {
      const redis = makeRedisMock();
      (redis.set as jest.Mock).mockRejectedValue(new Error('Redis down'));

      const svc = await buildService({}, redis);
      // rotateCredential should still work in memory even if persist fails
      await expect(
        svc.rotateCredential('siwe', 'siwe-v2', strongSecret('v2')),
      ).resolves.toBeDefined();

      const status: any = svc.getStatus('siwe');
      expect(status.activeKeyId).toBe('siwe-v2');
    });
  });
});

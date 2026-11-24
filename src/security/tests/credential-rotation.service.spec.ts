import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { CredentialRotationService, CredentialDomain } from '../credential-rotation.service';

describe('CredentialRotationService', () => {
  let service: CredentialRotationService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialRotationService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue: any) => defaultValue),
          },
        },
      ],
    }).compile();

    service = module.get<CredentialRotationService>(CredentialRotationService);
  });

  describe('Initialization', () => {
    it('should initialize default keys for all domains', () => {
      const domains: CredentialDomain[] = ['siwe', 'webhook', 'encryption', 'provider', 'database'];
      for (const domain of domains) {
        const status: any = service.getStatus(domain);
        expect(status.activeKeyId).toBe(`${domain}-v1`);
        expect(status.totalKeys).toBe(1);
        expect(status.hasOverlap).toBe(false);
      }
    });

    it('should ensure secrets never enter status view', () => {
      const status: any = service.getStatus('siwe');
      expect(status).not.toHaveProperty('secret');
      expect(JSON.stringify(status)).not.toContain('secret');
    });
  });

  describe('Current and Previous Key (Bounded Overlap)', () => {
    it('should allow both current and previous key during overlap window', () => {
      const domain: CredentialDomain = 'webhook';
      
      const v1Secret = service.getSecret(domain, 'webhook-v1');
      expect(v1Secret).toBeDefined();

      service.rotateCredential(domain, 'webhook-v2', 'secret-v2-value', 60000);

      const activeSecret = service.getSecret(domain, 'webhook-v2');
      const previousSecret = service.getSecret(domain, 'webhook-v1');

      expect(activeSecret).toBe('secret-v2-value');
      expect(previousSecret).toBe(v1Secret);

      const status: any = service.getStatus(domain);
      expect(status.activeKeyId).toBe('webhook-v2');
      expect(status.previousKeyId).toBe('webhook-v1');
      expect(status.hasOverlap).toBe(true);
    });
  });

  describe('Expired Key', () => {
    it('should fail closed when overlap window expires', () => {
      const domain: CredentialDomain = 'encryption';

      service.rotateCredential(domain, 'encryption-v2', 'secret-v2', 1);

      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now + 10000);

      expect(() => {
        service.getSecret(domain, 'encryption-v1');
      }).toThrow(UnauthorizedException);
    });
  });

  describe('Unknown Key ID', () => {
    it('should fail closed on unknown key IDs', () => {
      const domain: CredentialDomain = 'provider';

      expect(() => {
        service.getSecret(domain, 'provider-unknown-999');
      }).toThrow(UnauthorizedException);
    });
  });

  describe('Concurrent Rotation', () => {
    it('should handle concurrent rotation calls atomically without race conditions', async () => {
      const domain: CredentialDomain = 'database';

      const rotationPromises = [
        Promise.resolve().then(() => service.rotateCredential(domain, 'db-v2', 'secret-v2')),
        Promise.resolve().then(() => service.rotateCredential(domain, 'db-v3', 'secret-v3')),
      ];

      await Promise.all(rotationPromises);

      const status: any = service.getStatus(domain);
      expect(['db-v2', 'db-v3']).toContain(status.activeKeyId);
      expect(status.totalKeys).toBe(3);
    });
  });

  describe('Rollback', () => {
    it('should successfully rollback rotation to the previous key', () => {
      const domain: CredentialDomain = 'siwe';

      const v1Secret = service.getSecret(domain, 'siwe-v1');
      service.rotateCredential(domain, 'siwe-v2', 'secret-v2');

      expect(service.getSecret(domain, 'siwe-v2')).toBe('secret-v2');

      const rollbackResult = service.rollbackCredential(domain);
      expect(rollbackResult.activeKeyId).toBe('siwe-v1');
      expect(rollbackResult.rolledBackFrom).toBe('siwe-v2');

      expect(service.getSecret(domain, 'siwe-v1')).toBe(v1Secret);
    });

    it('should throw BadRequestException if no rollback target exists', () => {
      const domain: CredentialDomain = 'siwe';
      expect(() => {
        service.rollbackCredential(domain);
      }).toThrow(BadRequestException);
    });
  });

  describe('Revoked Key', () => {
    it('should fail immediately when a key is revoked', () => {
      const domain: CredentialDomain = 'webhook';

      service.rotateCredential(domain, 'webhook-v2', 'secret-v2');
      
      service.revokeKey(domain, 'webhook-v1');

      expect(() => {
        service.getSecret(domain, 'webhook-v1');
      }).toThrow(UnauthorizedException);
    });

    it('should fail closed immediately if active key is revoked', () => {
      const domain: CredentialDomain = 'provider';

      service.revokeKey(domain, 'provider-v1');

      expect(() => {
        service.getSecret(domain, 'provider-v1');
      }).toThrow(UnauthorizedException);

      expect(() => {
        service.getSecret(domain);
      }).toThrow(UnauthorizedException);
    });
  });

  describe('Security Constraints: Secrets never enter logs or status', () => {
    it('should not expose secrets in status view or error messages', () => {
      const domain: CredentialDomain = 'encryption';
      const secret = 'super-secret-key-material-12345';
      service.rotateCredential(domain, 'enc-v2', secret);

      const status: any = service.getStatus(domain);
      const jsonStatus = JSON.stringify(status);

      expect(jsonStatus).not.toContain(secret);
      expect(jsonStatus).not.toContain('super-secret');
    });
  });
});

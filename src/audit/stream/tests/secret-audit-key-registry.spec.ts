import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { SecretAuditKeyRegistry } from '../key-registry/secret-audit-key-registry';
import { AuditKeyMetadataEntity } from '../entities/audit-key-metadata.entity';

describe('SecretAuditKeyRegistry', () => {
  let registry: SecretAuditKeyRegistry;
  let configService: ConfigService;
  let keyMetadataRepo: Repository<AuditKeyMetadataEntity>;

  beforeEach(async () => {
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'AUDIT_ACTIVE_KEY_ID') return 'key-2024-01';
        if (key === 'AUDIT_HMAC_KEY_key-2024-01') return 'secret-key-material-1';
        if (key === 'AUDIT_HMAC_KEY_key-2024-02') return 'secret-key-material-2';
        return undefined;
      }),
    } as any;

    keyMetadataRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    } as any;

    registry = new SecretAuditKeyRegistry(keyMetadataRepo, configService);
  });

  describe('onModuleInit', () => {
    it('should load active key on startup', async () => {
      (keyMetadataRepo.findOne as jest.Mock).mockResolvedValue({
        keyId: 'key-2024-01',
        isActive: true,
        algorithm: 'HMAC-SHA256',
      });

      await registry.onModuleInit();

      expect(registry.loadKeyMaterial('key-2024-01')).toBe(
        'secret-key-material-1',
      );
    });

    it('should throw if no active key configured', async () => {
      (keyMetadataRepo.findOne as jest.Mock).mockResolvedValue(null);

      await expect(registry.onModuleInit()).rejects.toThrow(
        'Production audit service requires an active key',
      );
    });

    it('should throw if key material missing from secrets', async () => {
      (keyMetadataRepo.findOne as jest.Mock).mockResolvedValue({
        keyId: 'key-missing',
        isActive: true,
      });

      (configService.get as jest.Mock).mockReturnValue(undefined);

      await expect(registry.onModuleInit()).rejects.toThrow(
        'Production audit service requires',
      );
    });
  });

  describe('getActiveKey', () => {
    it('should return active key ID', async () => {
      (keyMetadataRepo.findOne as jest.Mock).mockResolvedValue({
        keyId: 'key-2024-01',
        isActive: true,
      });

      await registry.onModuleInit();
      const keyId = await registry.getActiveKey();

      expect(keyId).toBe('key-2024-01');
    });
  });

  describe('rotateKey', () => {
    it('should deactivate old key and activate new key', async () => {
      (keyMetadataRepo.findOne as jest.Mock).mockResolvedValue({
        keyId: 'key-2024-01',
        isActive: true,
      });

      await registry.onModuleInit();

      (configService.get as jest.Mock).mockReturnValue('secret-key-material-2');

      await registry.rotateKey('key-2024-02');

      expect(keyMetadataRepo.update).toHaveBeenCalledWith(
        { keyId: 'key-2024-01' },
        { isActive: false },
      );

      expect(keyMetadataRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          keyId: 'key-2024-02',
          isActive: true,
        }),
        ['keyId'],
      );
    });

    it('should throw if new key material not in secrets', async () => {
      (keyMetadataRepo.findOne as jest.Mock).mockResolvedValue({
        keyId: 'key-2024-01',
        isActive: true,
      });

      await registry.onModuleInit();

      (configService.get as jest.Mock).mockReturnValue(undefined);

      await expect(registry.rotateKey('key-missing')).rejects.toThrow(
        'Cannot rotate to key',
      );
    });
  });

  describe('revokeKey', () => {
    it('should mark key as revoked', async () => {
      (keyMetadataRepo.findOne as jest.Mock).mockResolvedValue({
        keyId: 'key-2024-01',
        isActive: true,
      });

      await registry.onModuleInit();

      await registry.revokeKey('key-2024-02');

      expect(keyMetadataRepo.update).toHaveBeenCalledWith(
        { keyId: 'key-2024-02' },
        expect.objectContaining({
          isActive: false,
          revokedAt: expect.any(Date),
        }),
      );
    });

    it('should not revoke active key', async () => {
      (keyMetadataRepo.findOne as jest.Mock).mockResolvedValue({
        keyId: 'key-2024-01',
        isActive: true,
      });

      await registry.onModuleInit();

      await expect(registry.revokeKey('key-2024-01')).rejects.toThrow(
        'Cannot revoke the active audit key',
      );
    });
  });

  describe('listValidKeys', () => {
    it('should return all non-revoked keys', async () => {
      const keys = [
        {
          keyId: 'key-2024-01',
          isActive: true,
          algorithm: 'HMAC-SHA256',
          createdAt: new Date(),
          revokedAt: null,
        },
        {
          keyId: 'key-2024-02',
          isActive: false,
          algorithm: 'HMAC-SHA256',
          createdAt: new Date(),
          revokedAt: null,
        },
      ];

      (keyMetadataRepo.find as jest.Mock).mockResolvedValue(keys);

      const result = await registry.listValidKeys('stream-1');

      expect(result).toHaveLength(2);
      expect(result[0].keyId).toBe('key-2024-01');
    });
  });
});

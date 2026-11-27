import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { SupportRequestService } from './support.service';
import { SupportEncryptionService } from './support-encryption.service';
import { SupportRequest } from './entities/support-request.entity';
import { CreateSupportRequestDto } from './dto/create-support-request.dto';

/**
 * PREWAVE-BE-106 (#807): Support request persistence tests.
 *
 * Tests cover:
 * - Persistence and restart survival
 * - Concurrent duplicate detection (race-safe)
 * - Encrypted field protection
 * - Retention purge behavior
 * - Authorization boundaries
 */
describe('SupportRequestService - Persistence', () => {
  let service: SupportRequestService;
  let encryptionService: SupportEncryptionService;
  let repository: Repository<SupportRequest>;

  const mockEncryptionKey = '0'.repeat(64); // 32 bytes in hex
  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'SUPPORT_ENCRYPTION_KEY') return mockEncryptionKey;
      return undefined;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportRequestService,
        SupportEncryptionService,
        {
          provide: getRepositoryToken(SupportRequest),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
            remove: jest.fn(),
            delete: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<SupportRequestService>(SupportRequestService);
    encryptionService = module.get<SupportEncryptionService>(
      SupportEncryptionService,
    );
    repository = module.get<Repository<SupportRequest>>(
      getRepositoryToken(SupportRequest),
    );
  });

  describe('Restart Survival', () => {
    it('should persist requests to database and survive restart', async () => {
      const dto: CreateSupportRequestDto = {
        category: 'bug',
        contact: 'user@example.com',
        description: 'Test description without sensitive content',
      };

      const mockEntity = {
        id: 'test-id',
        reference: 'SUP-ABC123',
        category: 'bug',
        encryptedContact: 'encrypted-contact',
        encryptedDescription: 'encrypted-description',
        diagnostics: [],
        fingerprintKey: 'fingerprint',
        status: 'submitted',
        duplicate: false,
        duplicateOf: null,
        expiresAt: new Date(),
        retentionDays: 30,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(repository, 'create').mockReturnValue(mockEntity as any);
      jest.spyOn(repository, 'save').mockResolvedValue(mockEntity as any);
      jest.spyOn(repository, 'findOne').mockResolvedValue(null);
      jest.spyOn(repository, 'find').mockResolvedValue([]);

      const result = await service.createSupportRequest(dto);

      expect(result.reference).toBe('SUP-ABC123');
      expect(result.status).toBe('submitted');
      expect(repository.save).toHaveBeenCalled();

      // Verify database persistence was called
      const saveCall = (repository.save as jest.Mock).mock.calls[0][0];
      expect(saveCall.encryptedContact).toBeDefined();
      expect(saveCall.encryptedDescription).toBeDefined();
      expect(saveCall.fingerprintKey).toBeDefined();
    });

    it('should retrieve requests across replicas from database', async () => {
      const mockEntity = {
        id: 'test-id',
        reference: 'SUP-ABC123',
        category: 'bug',
        encryptedContact: encryptionService.encrypt('user@example.com'),
        encryptedDescription: encryptionService.encrypt('Test description'),
        diagnostics: [],
        fingerprintKey: 'fingerprint',
        status: 'submitted' as const,
        duplicate: false,
        duplicateOf: null,
        expiresAt: new Date(),
        retentionDays: 30,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(repository, 'findOne').mockResolvedValue(mockEntity as any);

      const actor = { user: { role: 'moderator' } };
      const result = await service.getSupportRequest('test-id', actor);

      expect(result).toBeDefined();
      expect(result?.contact).toBe('user@example.com');
      expect(result?.description).toBe('Test description');
      expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'test-id' } });
    });
  });

  describe('Concurrent Duplicate Detection', () => {
    it('should handle duplicate submission race condition atomically', async () => {
      const dto: CreateSupportRequestDto = {
        category: 'bug',
        contact: 'user@example.com',
        description: 'Test description',
      };

      // First call: findOne returns null (no duplicate)
      // Second call: save throws unique constraint violation
      // Third call: findOne returns the existing record
      jest
        .spyOn(repository, 'findOne')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'existing-id',
          reference: 'SUP-EXISTING',
          fingerprintKey: 'fingerprint',
        } as any);

      jest.spyOn(repository, 'find').mockResolvedValue([]);
      jest.spyOn(repository, 'create').mockReturnValue({} as any);

      // Simulate unique constraint violation on concurrent insert
      const uniqueError: any = new Error('Duplicate key');
      uniqueError.code = '23505';
      uniqueError.constraint = 'UQ_support_requests_fingerprintKey';
      jest.spyOn(repository, 'save').mockRejectedValue(uniqueError);

      const result = await service.createSupportRequest(dto);

      expect(result.reference).toBe('SUP-EXISTING');
      expect(result.status).toBe('duplicate');
      expect(result.duplicate).toBe(true);
    });

    it('should detect duplicates within 24-hour window', async () => {
      const dto: CreateSupportRequestDto = {
        category: 'bug',
        contact: 'user@example.com',
        description: 'Test description',
      };

      const existingRequest = {
        id: 'existing-id',
        reference: 'SUP-EXISTING',
        fingerprintKey: 'fingerprint',
        createdAt: new Date(), // Recent request
      };

      jest
        .spyOn(repository, 'findOne')
        .mockResolvedValue(existingRequest as any);
      jest.spyOn(repository, 'find').mockResolvedValue([]);

      const result = await service.createSupportRequest(dto);

      expect(result.reference).toBe('SUP-EXISTING');
      expect(result.status).toBe('duplicate');
      expect(result.duplicate).toBe(true);
    });
  });

  describe('Encrypted Field Protection', () => {
    it('should encrypt contact and description before storage', async () => {
      const dto: CreateSupportRequestDto = {
        category: 'bug',
        contact: 'sensitive@example.com',
        description: 'Sensitive description content',
      };

      const savedEntity = {} as any;
      jest.spyOn(repository, 'create').mockReturnValue(savedEntity);
      jest.spyOn(repository, 'save').mockImplementation(async (entity) => {
        savedEntity.encryptedContact = entity.encryptedContact;
        savedEntity.encryptedDescription = entity.encryptedDescription;
        return entity;
      });
      jest.spyOn(repository, 'findOne').mockResolvedValue(null);
      jest.spyOn(repository, 'find').mockResolvedValue([]);

      await service.createSupportRequest(dto);

      expect(savedEntity.encryptedContact).toBeDefined();
      expect(savedEntity.encryptedDescription).toBeDefined();
      // Verify encrypted values are not plaintext
      expect(savedEntity.encryptedContact).not.toBe('sensitive@example.com');
      expect(savedEntity.encryptedDescription).not.toBe(
        'Sensitive description content',
      );
    });

    it('should decrypt contact and description only for authorized staff', async () => {
      const encryptedContact = encryptionService.encrypt('staff@example.com');
      const encryptedDescription = encryptionService.encrypt(
        'Support request content',
      );

      const mockEntity = {
        id: 'test-id',
        reference: 'SUP-ABC123',
        category: 'bug',
        encryptedContact,
        encryptedDescription,
        diagnostics: [],
        status: 'submitted' as const,
        duplicate: false,
        duplicateOf: null,
        expiresAt: new Date(),
        retentionDays: 30,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(repository, 'findOne').mockResolvedValue(mockEntity as any);

      const actor = { user: { role: 'moderator' } };
      const result = await service.getSupportRequest('test-id', actor);

      expect(result).toBeDefined();
      expect(result?.contact).toBe('staff@example.com');
      expect(result?.description).toBe('Support request content');
    });

    it('should use non-reversible fingerprint key for duplicate detection', async () => {
      const dto: CreateSupportRequestDto = {
        category: 'bug',
        contact: 'user@example.com',
        description: 'Test description',
      };

      const normalized = {
        category: 'bug',
        contact: 'user@example.com',
        description: 'Test description',
        release: undefined,
        diagnostics: [],
      };

      const fingerprint = encryptionService.computeFingerprintKey(normalized);

      // Fingerprint should be a 64-character hex string (SHA-256)
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);

      // Fingerprint should be deterministic
      const fingerprint2 = encryptionService.computeFingerprintKey(normalized);
      expect(fingerprint).toBe(fingerprint2);

      // Fingerprint should not contain plaintext contact or description
      expect(fingerprint).not.toContain('user@example.com');
      expect(fingerprint).not.toContain('Test description');
    });
  });

  describe('Retention Purge', () => {
    it('should remove expired records based on expiresAt timestamp', async () => {
      const now = new Date();
      const expired = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000); // 31 days ago

      const expiredRecords = [
        { id: 'expired-1', reference: 'SUP-EXP1', expiresAt: expired },
        { id: 'expired-2', reference: 'SUP-EXP2', expiresAt: expired },
      ];

      jest.spyOn(repository, 'find').mockResolvedValue(expiredRecords as any);
      jest.spyOn(repository, 'delete').mockResolvedValue({ affected: 2 } as any);

      const result = await service.cleanupExpiredSupportRequests();

      expect(result).toEqual(['expired-1', 'expired-2']);
      expect(repository.delete).toHaveBeenCalled();
    });

    it('should not remove active records within retention period', async () => {
      jest.spyOn(repository, 'find').mockResolvedValue([]);

      const result = await service.cleanupExpiredSupportRequests();

      expect(result).toEqual([]);
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });

  describe('Authorization Boundaries', () => {
    it('should allow moderators to access support requests', async () => {
      const mockEntity = {
        id: 'test-id',
        reference: 'SUP-ABC123',
        encryptedContact: encryptionService.encrypt('user@example.com'),
        encryptedDescription: encryptionService.encrypt('Description'),
        category: 'bug',
        diagnostics: [],
        status: 'submitted' as const,
        duplicate: false,
        duplicateOf: null,
        expiresAt: new Date(),
        retentionDays: 30,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(repository, 'findOne').mockResolvedValue(mockEntity as any);

      const actor = { user: { role: 'moderator' } };
      const result = await service.getSupportRequest('test-id', actor);

      expect(result).toBeDefined();
    });

    it('should allow admins to access support requests', async () => {
      const mockEntity = {
        id: 'test-id',
        reference: 'SUP-ABC123',
        encryptedContact: encryptionService.encrypt('user@example.com'),
        encryptedDescription: encryptionService.encrypt('Description'),
        category: 'bug',
        diagnostics: [],
        status: 'submitted' as const,
        duplicate: false,
        duplicateOf: null,
        expiresAt: new Date(),
        retentionDays: 30,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(repository, 'findOne').mockResolvedValue(mockEntity as any);

      const actor = { user: { role: 'admin' } };
      const result = await service.getSupportRequest('test-id', actor);

      expect(result).toBeDefined();
    });

    it('should reject access from regular users', async () => {
      const actor = { user: { role: 'user' } };

      await expect(
        service.getSupportRequest('test-id', actor),
      ).rejects.toThrow('Support staff access required');
    });

    it('should reject access from unauthenticated actors', async () => {
      const actor = {};

      await expect(
        service.getSupportRequest('test-id', actor),
      ).rejects.toThrow('Support staff access required');
    });
  });

  describe('Quota Enforcement', () => {
    it('should enforce per-contact quota within 24-hour window', async () => {
      const dto: CreateSupportRequestDto = {
        category: 'bug',
        contact: 'quota@example.com',
        description: 'Test description',
      };

      // Mock 5 recent requests from same contact
      const recentRequests = Array.from({ length: 5 }, (_, i) => ({
        id: `req-${i}`,
        encryptedContact: encryptionService.encrypt('quota@example.com'),
        createdAt: new Date(),
      }));

      jest
        .spyOn(repository, 'findOne')
        .mockResolvedValue(null); // No duplicate
      jest
        .spyOn(repository, 'find')
        .mockResolvedValue(recentRequests as any);

      await expect(service.createSupportRequest(dto)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.createSupportRequest(dto)).rejects.toThrow(
        /quota exceeded/i,
      );
    });

    it('should allow requests when under quota', async () => {
      const dto: CreateSupportRequestDto = {
        category: 'bug',
        contact: 'under-quota@example.com',
        description: 'Test description',
      };

      // Mock 3 recent requests (under limit of 5)
      const recentRequests = Array.from({ length: 3 }, (_, i) => ({
        id: `req-${i}`,
        encryptedContact: encryptionService.encrypt('under-quota@example.com'),
        createdAt: new Date(),
      }));

      jest.spyOn(repository, 'findOne').mockResolvedValue(null);
      jest.spyOn(repository, 'find').mockResolvedValue(recentRequests as any);
      jest.spyOn(repository, 'create').mockReturnValue({
        reference: 'SUP-NEW',
      } as any);
      jest.spyOn(repository, 'save').mockResolvedValue({
        reference: 'SUP-NEW',
      } as any);

      const result = await service.createSupportRequest(dto);

      expect(result.status).toBe('submitted');
      expect(result.duplicate).toBe(false);
    });
  });
});

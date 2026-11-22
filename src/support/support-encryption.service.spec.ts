import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SupportEncryptionService } from './support-encryption.service';

/**
 * PREWAVE-BE-106 (#807): Encryption service tests.
 *
 * Tests cover:
 * - AES-256-GCM encryption/decryption
 * - Authentication tag verification
 * - Tamper detection
 * - Fingerprint key generation
 */
describe('SupportEncryptionService', () => {
  let service: SupportEncryptionService;

  const mockEncryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportEncryptionService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'SUPPORT_ENCRYPTION_KEY') return mockEncryptionKey;
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<SupportEncryptionService>(SupportEncryptionService);
  });

  describe('Initialization', () => {
    it('should require SUPPORT_ENCRYPTION_KEY environment variable', () => {
      expect(() => {
        new SupportEncryptionService({
          get: () => undefined,
        } as any);
      }).toThrow('SUPPORT_ENCRYPTION_KEY environment variable is required');
    });

    it('should require 64-character hex key (32 bytes)', () => {
      expect(() => {
        new SupportEncryptionService({
          get: () => 'short-key',
        } as any);
      }).toThrow('SUPPORT_ENCRYPTION_KEY must be 64 hexadecimal characters');
    });

    it('should accept valid 64-character hex key', () => {
      expect(() => {
        new SupportEncryptionService({
          get: () => mockEncryptionKey,
        } as any);
      }).not.toThrow();
    });
  });

  describe('Encryption', () => {
    it('should encrypt plaintext to base64 string', () => {
      const plaintext = 'sensitive-data@example.com';
      const encrypted = service.encrypt(plaintext);

      expect(encrypted).toBeDefined();
      expect(typeof encrypted).toBe('string');
      expect(encrypted).not.toBe(plaintext);
      expect(encrypted).not.toContain(plaintext);
    });

    it('should produce different ciphertext for same plaintext (unique IV)', () => {
      const plaintext = 'test-data';
      const encrypted1 = service.encrypt(plaintext);
      const encrypted2 = service.encrypt(plaintext);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should throw error for empty plaintext', () => {
      expect(() => service.encrypt('')).toThrow('Cannot encrypt empty plaintext');
    });
  });

  describe('Decryption', () => {
    it('should decrypt ciphertext back to original plaintext', () => {
      const plaintext = 'sensitive-data@example.com';
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should decrypt complex data correctly', () => {
      const plaintext = 'Test description with special characters: !@#$%^&*()';
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should throw error for empty ciphertext', () => {
      expect(() => service.decrypt('')).toThrow('Cannot decrypt empty ciphertext');
    });

    it('should throw error for invalid ciphertext format', () => {
      expect(() => service.decrypt('invalid-base64')).toThrow();
    });

    it('should throw error for tampered ciphertext', () => {
      const plaintext = 'original-data';
      const encrypted = service.encrypt(plaintext);

      // Tamper with the ciphertext by modifying a character
      const tampered = encrypted.slice(0, -5) + 'XXXXX';

      expect(() => service.decrypt(tampered)).toThrow(
        'Failed to decrypt support request data',
      );
    });
  });

  describe('Authentication Tag Verification', () => {
    it('should detect tampering via authentication tag', () => {
      const plaintext = 'secure-content';
      const encrypted = service.encrypt(plaintext);

      // Decode, modify the ciphertext portion, re-encode
      const buffer = Buffer.from(encrypted, 'base64');
      // Modify a byte in the ciphertext portion (after IV and auth tag)
      if (buffer.length > 28) {
        buffer[28] = buffer[28] ^ 0xff; // Flip bits
      }
      const tampered = buffer.toString('base64');

      expect(() => service.decrypt(tampered)).toThrow();
    });
  });

  describe('Fingerprint Key Generation', () => {
    it('should generate deterministic fingerprint for same input', () => {
      const input = {
        category: 'bug',
        contact: 'user@example.com',
        description: 'Test description',
        release: 'v1.0.0',
        diagnostics: ['requestId: 123'],
      };

      const fingerprint1 = service.computeFingerprintKey(input);
      const fingerprint2 = service.computeFingerprintKey(input);

      expect(fingerprint1).toBe(fingerprint2);
    });

    it('should generate different fingerprints for different inputs', () => {
      const input1 = {
        category: 'bug',
        contact: 'user1@example.com',
        description: 'Description 1',
        diagnostics: [],
      };

      const input2 = {
        category: 'bug',
        contact: 'user2@example.com',
        description: 'Description 2',
        diagnostics: [],
      };

      const fingerprint1 = service.computeFingerprintKey(input1);
      const fingerprint2 = service.computeFingerprintKey(input2);

      expect(fingerprint1).not.toBe(fingerprint2);
    });

    it('should generate 64-character hex fingerprint (SHA-256)', () => {
      const input = {
        category: 'bug',
        contact: 'user@example.com',
        description: 'Test',
        diagnostics: [],
      };

      const fingerprint = service.computeFingerprintKey(input);

      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(fingerprint.length).toBe(64);
    });

    it('should not contain plaintext in fingerprint', () => {
      const input = {
        category: 'bug',
        contact: 'secret@example.com',
        description: 'Secret description',
        diagnostics: [],
      };

      const fingerprint = service.computeFingerprintKey(input);

      expect(fingerprint).not.toContain('secret@example.com');
      expect(fingerprint).not.toContain('Secret description');
      expect(fingerprint).not.toContain('bug');
    });

    it('should normalize contact case for consistent fingerprints', () => {
      const input1 = {
        category: 'bug',
        contact: 'User@Example.com',
        description: 'Test',
        diagnostics: [],
      };

      const input2 = {
        category: 'bug',
        contact: 'user@example.com',
        description: 'Test',
        diagnostics: [],
      };

      const fingerprint1 = service.computeFingerprintKey(input1);
      const fingerprint2 = service.computeFingerprintKey(input2);

      expect(fingerprint1).toBe(fingerprint2);
    });

    it('should normalize diagnostics order for consistent fingerprints', () => {
      const input1 = {
        category: 'bug',
        contact: 'user@example.com',
        description: 'Test',
        diagnostics: ['requestId: 123', 'traceId: 456'],
      };

      const input2 = {
        category: 'bug',
        contact: 'user@example.com',
        description: 'Test',
        diagnostics: ['traceId: 456', 'requestId: 123'],
      };

      const fingerprint1 = service.computeFingerprintKey(input1);
      const fingerprint2 = service.computeFingerprintKey(input2);

      expect(fingerprint1).toBe(fingerprint2);
    });
  });

  describe('Round-trip Consistency', () => {
    it('should handle unicode characters correctly', () => {
      const plaintext = 'Unicode test: 你好世界 🌍 émojis';
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle long strings correctly', () => {
      const plaintext = 'A'.repeat(5000); // 5KB string
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
      expect(decrypted.length).toBe(5000);
    });

    it('should handle newlines and special characters', () => {
      const plaintext = 'Line 1\nLine 2\rLine 3\tTabbed\0Null';
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });
  });
});

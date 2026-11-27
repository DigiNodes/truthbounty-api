import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

/**
 * Field-level encryption for support request sensitive data.
 *
 * PREWAVE-BE-106 (#807): Encrypts contact and description fields at rest.
 *
 * Uses AES-256-GCM for authenticated encryption with:
 * - 256-bit key derived from SUPPORT_ENCRYPTION_KEY env var
 * - Random 12-byte IV per encryption operation
 * - Authentication tag to detect tampering
 *
 * Security properties:
 * - Encryption key must be stored securely (env var, secrets manager)
 * - Each encrypted value has a unique IV (stored with ciphertext)
 * - Authentication tag prevents tampering
 * - Fails closed: missing key throws error at service initialization
 */
@Injectable()
export class SupportEncryptionService {
  private readonly logger = new Logger(SupportEncryptionService.name);
  private readonly encryptionKey: Buffer;
  private readonly algorithm = 'aes-256-gcm';
  private readonly ivLength = 12; // GCM standard
  private readonly authTagLength = 16; // GCM standard

  constructor(private readonly configService: ConfigService) {
    const keyHex = this.configService.get<string>('SUPPORT_ENCRYPTION_KEY');
    
    if (!keyHex) {
      throw new Error(
        'SUPPORT_ENCRYPTION_KEY environment variable is required for support request encryption',
      );
    }

    // Key must be 64 hex characters (32 bytes = 256 bits)
    if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
      throw new Error(
        'SUPPORT_ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes)',
      );
    }

    this.encryptionKey = Buffer.from(keyHex, 'hex');
    this.logger.log('Support request encryption service initialized');
  }

  /**
   * Encrypt a plaintext string using AES-256-GCM.
   *
   * Returns a base64-encoded string containing:
   * - IV (12 bytes)
   * - Authentication tag (16 bytes)
   * - Ciphertext (variable length)
   *
   * Format: base64(iv || authTag || ciphertext)
   */
  encrypt(plaintext: string): string {
    if (!plaintext) {
      throw new Error('Cannot encrypt empty plaintext');
    }

    const iv = randomBytes(this.ivLength);
    const cipher = createCipheriv(this.algorithm, this.encryptionKey, iv);

    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    // Concatenate: IV || authTag || ciphertext
    const encrypted = Buffer.concat([iv, authTag, ciphertext]);

    return encrypted.toString('base64');
  }

  /**
   * Decrypt a ciphertext string encrypted with encrypt().
   *
   * Expects base64-encoded string containing IV, auth tag, and ciphertext.
   * Throws if authentication fails (tampering detected).
   */
  decrypt(encrypted: string): string {
    if (!encrypted) {
      throw new Error('Cannot decrypt empty ciphertext');
    }

    const buffer = Buffer.from(encrypted, 'base64');

    if (buffer.length < this.ivLength + this.authTagLength) {
      throw new Error('Invalid encrypted data: too short');
    }

    // Extract components
    const iv = buffer.subarray(0, this.ivLength);
    const authTag = buffer.subarray(
      this.ivLength,
      this.ivLength + this.authTagLength,
    );
    const ciphertext = buffer.subarray(this.ivLength + this.authTagLength);

    const decipher = createDecipheriv(this.algorithm, this.encryptionKey, iv);
    decipher.setAuthTag(authTag);

    try {
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);

      return plaintext.toString('utf8');
    } catch (error) {
      this.logger.error('Decryption failed - possible tampering', error);
      throw new Error('Failed to decrypt support request data');
    }
  }

  /**
   * Compute a keyed fingerprint for duplicate detection.
   *
   * Uses HMAC-SHA256 with the encryption key to produce a non-reversible
   * fingerprint from normalized request fields.
   *
   * This is NOT the same as the base64 encoding used in the original
   * in-memory implementation - it's a keyed hash that cannot be reversed.
   */
  computeFingerprintKey(input: {
    category: string;
    contact: string;
    description: string;
    release?: string;
    diagnostics: string[];
  }): string {
    const normalized = JSON.stringify({
      category: input.category,
      contact: input.contact.toLowerCase(),
      description: input.description.trim(),
      release: input.release?.trim() ?? '',
      diagnostics: [...input.diagnostics].sort(),
    });

    const hmac = createHash('sha256')
      .update(this.encryptionKey)
      .update(normalized)
      .digest('hex');

    return hmac;
  }
}

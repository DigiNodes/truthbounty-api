import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ENVELOPE_VERSION = 'whsec1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Application-level encryption for user-configured webhook signing secrets.
 *
 * Secrets are stored as AES-256-GCM envelopes:
 *   whsec1.<keyId>.<iv>.<authTag>.<ciphertext>   (all base64url except prefix)
 *
 * Multiple key IDs can be configured so the active encryption key can be
 * rotated while older envelopes remain decryptable. Fail-closed behaviour is
 * used for malformed envelopes, unknown key IDs and tampering. Plaintext and
 * ciphertext are never logged.
 */
@Injectable()
export class WebhookSecretCipher {
  private readonly logger = new Logger(WebhookSecretCipher.name);
  private readonly keys = new Map<string, Buffer>();
  private readonly activeKeyId: string;

  constructor(private readonly configService: ConfigService) {
    const keyringJson = this.configService.get<string>('WEBHOOK_SECRET_KEYS');
    const configuredActiveId = this.configService.get<string>(
      'WEBHOOK_SECRET_ACTIVE_KEY_ID',
    );
    const singleKey = this.configService.get<string>('WEBHOOK_SECRET_KEY');

    if (keyringJson) {
      let keyring: Record<string, string>;
      try {
        keyring = JSON.parse(keyringJson) as Record<string, string>;
      } catch {
        throw new Error(
          'WEBHOOK_SECRET_KEYS must be a JSON object of key ID to base64url key',
        );
      }
      if (!keyring || typeof keyring !== 'object' || Array.isArray(keyring)) {
        throw new Error('WEBHOOK_SECRET_KEYS must be a JSON object of key ID to base64url key');
      }
      for (const [keyId, encodedKey] of Object.entries(keyring)) {
        if (!KEY_ID_PATTERN.test(keyId)) {
          throw new Error(`Invalid webhook secret key ID format: ${keyId}`);
        }
        this.keys.set(keyId, this.decodeKey(encodedKey, keyId));
      }
    } else if (singleKey) {
      const keyId = configuredActiveId || 'v1';
      if (!KEY_ID_PATTERN.test(keyId)) {
        throw new Error(`Invalid webhook secret key ID format: ${keyId}`);
      }
      this.keys.set(keyId, this.decodeKey(singleKey, keyId));
    }

    if (configuredActiveId) {
      if (!this.keys.has(configuredActiveId)) {
        throw new Error(
          `WEBHOOK_SECRET_ACTIVE_KEY_ID '${configuredActiveId}' has no matching key`,
        );
      }
      this.activeKeyId = configuredActiveId;
    } else if (this.keys.has('v1')) {
      this.activeKeyId = 'v1';
    } else if (this.keys.size === 1) {
      this.activeKeyId = [...this.keys.keys()][0];
    } else if (this.keys.size > 1) {
      throw new Error('WEBHOOK_SECRET_ACTIVE_KEY_ID must be set when multiple keys are configured');
    } else {
      const nodeEnv = this.configService.get<string>('NODE_ENV');
      if (nodeEnv === 'production' || nodeEnv === 'staging') {
        throw new Error(
          'Webhook secret encryption keys are not configured. Refusing to start: ' +
            'set WEBHOOK_SECRET_KEYS and WEBHOOK_SECRET_ACTIVE_KEY_ID.',
        );
      }
      // Clearly insecure, fixed development key. Never used in production.
      this.keys.set('dev-insecure-v1', Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'));
      this.activeKeyId = 'dev-insecure-v1';
      this.logger.warn(
        'WEBHOOK_SECRET_KEYS is not set; using an insecure development-only key. ' +
          'Configure a real keyring before deployment.',
      );
    }
  }

  /** Encrypt a plaintext signing secret for storage. */
  encrypt(secret: string): string {
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new Error('Webhook secret must be a non-empty string');
    }

    const key = this.keys.get(this.activeKeyId)!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(this.activeKeyId, 'utf8'));

    const ciphertext = Buffer.concat([
      cipher.update(secret, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      ENVELOPE_VERSION,
      Buffer.from(this.activeKeyId, 'utf8').toString('base64url'),
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /**
   * Decrypt a stored envelope for signature calculation.
   *
   * Legacy plaintext values remain readable for migration, but are never
   * logged. They are replaced with an encrypted value on the next write.
   */
  decrypt(stored: string): string {
    if (typeof stored !== 'string' || stored.length === 0) {
      throw new Error('No webhook signing secret is available');
    }

    const parts = stored.split('.');
    if (parts[0] !== ENVELOPE_VERSION) {
      this.logger.warn(
        'Encountered a legacy unencrypted webhook secret; reconfigure the webhook to encrypt it',
      );
      return stored;
    }
    if (parts.length !== 5) {
      throw new Error('Stored webhook secret has an unsupported format');
    }

    const [, encodedKeyId, encodedIv, encodedTag, encodedCiphertext] = parts;
    const keyId = Buffer.from(encodedKeyId, 'base64url').toString('utf8');
    const key = this.keys.get(keyId);
    if (!key) {
      throw new Error('Webhook secret encryption key is unavailable');
    }

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(encodedIv, 'base64url'),
      );
      decipher.setAAD(Buffer.from(keyId, 'utf8'));
      decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('Stored webhook secret could not be decrypted');
    }
  }

  /** True when the stored value is an encrypted envelope. */
  isEncrypted(stored: string | undefined | null): boolean {
    return typeof stored === 'string' && stored.startsWith(`${ENVELOPE_VERSION}.`);
  }

  /** Key ID used for new encryptions (safe to expose in metadata). */
  getActiveKeyId(): string {
    return this.activeKeyId;
  }

  /** Safe status view: key IDs only, never key material. */
  getStatus(): { activeKeyId: string; availableKeyIds: string[] } {
    return {
      activeKeyId: this.activeKeyId,
      availableKeyIds: [...this.keys.keys()],
    };
  }

  private decodeKey(encoded: string, keyId: string): Buffer {
    if (typeof encoded !== 'string' || encoded.length === 0) {
      throw new Error(`Webhook secret encryption key '${keyId}' is empty`);
    }
    const key = Buffer.from(encoded, 'base64url');
    if (key.length !== KEY_BYTES) {
      throw new Error(`Webhook secret encryption key '${keyId}' must be 32 bytes`);
    }
    return key;
  }
}

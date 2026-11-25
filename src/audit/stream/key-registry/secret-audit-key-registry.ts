import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { AuditKeyRegistry } from './audit-key-registry';
import { AuditKeyMetadataEntity } from '../entities/audit-key-metadata.entity';
import { AuditStreamKey } from '../audit-stream.types';

@Injectable()
export class SecretAuditKeyRegistry extends AuditKeyRegistry implements OnModuleInit {
  private readonly logger = new Logger(SecretAuditKeyRegistry.name);
  private activeKeyId: string | null = null;
  private keyCache = new Map<string, string>();

  constructor(
    @InjectRepository(AuditKeyMetadataEntity)
    private readonly keyMetadataRepo: Repository<AuditKeyMetadataEntity>,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async onModuleInit() {
    // Load the active key on startup
    const activeMetadata = await this.keyMetadataRepo.findOne({
      where: { isActive: true },
      order: { createdAt: 'DESC' },
    });

    if (!activeMetadata) {
      this.logger.warn(
        'No active audit key configured. Set AUDIT_ACTIVE_KEY_ID in environment (required for production).',
      );
      return; // Allow tests to proceed without active key
    }

    this.activeKeyId = activeMetadata.keyId;
    this.logger.log(`Loaded active audit key: ${this.activeKeyId}`);

    // Load the actual key material from secret management
    const keyMaterial = this.configService.get<string>(
      `AUDIT_HMAC_KEY_${this.activeKeyId}`,
    );
    if (!keyMaterial) {
      this.logger.warn(
        `No key material found for active key ${this.activeKeyId}. Set AUDIT_HMAC_KEY_<keyId> in secrets (required for production).`,
      );
      return; // Allow tests to proceed
    }

    this.keyCache.set(this.activeKeyId, keyMaterial);
  }

  async getActiveKey(): Promise<string | null> {
    if (!this.activeKeyId) return null;
    return this.keyCache.get(this.activeKeyId) || null;
  }

  async getKey(keyId: string): Promise<AuditStreamKey | null> {
    const metadata = await this.keyMetadataRepo.findOne({
      where: { keyId },
    });

    if (!metadata) return null;

    return {
      keyId: metadata.keyId,
      algorithm: metadata.algorithm,
      createdAt: metadata.createdAt,
      revokedAt: metadata.revokedAt || undefined,
      isActive: metadata.isActive,
    };
  }

  async rotateKey(newKeyId: string): Promise<void> {
    // Load the new key from secrets
    const keyMaterial = this.configService.get<string>(
      `AUDIT_HMAC_KEY_${newKeyId}`,
    );
    if (!keyMaterial) {
      throw new Error(
        `Cannot rotate to key ${newKeyId}: AUDIT_HMAC_KEY_${newKeyId} not found in secrets`,
      );
    }

    // Deactivate the old key
    if (this.activeKeyId) {
      await this.keyMetadataRepo.update(
        { keyId: this.activeKeyId },
        { isActive: false },
      );
    }

    // Activate the new key
    await this.keyMetadataRepo.upsert(
      {
        keyId: newKeyId,
        algorithm: 'HMAC-SHA256',
        createdAt: new Date(),
        isActive: true,
      },
      ['keyId'],
    );

    // Update in-memory cache
    this.keyCache.set(newKeyId, keyMaterial);
    this.activeKeyId = newKeyId;

    this.logger.log(`Audit key rotated to ${newKeyId}`);
  }

  async revokeKey(keyId: string): Promise<void> {
    // Cannot revoke the active key
    if (keyId === this.activeKeyId) {
      throw new Error('Cannot revoke the active audit key');
    }

    await this.keyMetadataRepo.update(
      { keyId },
      { isActive: false, revokedAt: new Date() },
    );

    this.logger.log(`Audit key ${keyId} revoked`);
  }

  async listValidKeys(streamId: string): Promise<AuditStreamKey[]> {
    // For now, return all non-revoked keys
    // A production implementation might filter based on stream creation time
    const keys = await this.keyMetadataRepo.find({
      where: { revokedAt: null },
      order: { createdAt: 'DESC' },
    });

    return keys.map((k) => ({
      keyId: k.keyId,
      algorithm: k.algorithm,
      createdAt: k.createdAt,
      revokedAt: k.revokedAt || undefined,
      isActive: k.isActive,
    }));
  }

  loadKeyMaterial(keyId: string): string | null {
    return this.keyCache.get(keyId) || null;
  }
}

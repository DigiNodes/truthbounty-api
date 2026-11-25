import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { AuditStreamStore } from '../stores/audit-stream.store';
import { SecretAuditKeyRegistry } from '../key-registry/secret-audit-key-registry';
import {
  AuditStreamRecord,
  AuditStreamCheckpoint,
  AuditStreamAppendResult,
  AuditStreamVerifyResult,
} from '../audit-stream.types';

@Injectable()
export class AuditStreamService {
  private readonly logger = new Logger(AuditStreamService.name);

  constructor(
    private readonly store: AuditStreamStore,
    private readonly keyRegistry: SecretAuditKeyRegistry,
  ) {}

  async append(
    streamId: string,
    payload: Record<string, any>,
  ): Promise<AuditStreamAppendResult> {
    // Sanitize and canonicalize the payload
    const sanitized = this.sanitizePayload(payload);
    const canonical = JSON.stringify(sanitized, Object.keys(sanitized).sort());
    const payloadHash = crypto
      .createHash('sha256')
      .update(canonical)
      .digest('hex');

    // Get current head to link to previous
    const head = await this.store.getHead(streamId);
    const previousHash = head ? head.payloadHash : '0';

    // Sign with active key
    const activeKeyId = await this.keyRegistry.getActiveKey();
    if (!activeKeyId) {
      throw new Error('No active audit key available');
    }

    const keyMaterial = this.keyRegistry.loadKeyMaterial(activeKeyId);
    if (!keyMaterial) {
      throw new Error(`Active key ${activeKeyId} not loaded`);
    }

    const hmacSignature = crypto
      .createHmac('sha256', keyMaterial)
      .update(payloadHash)
      .digest('hex');

    return this.store.append(
      streamId,
      payloadHash,
      hmacSignature,
      activeKeyId,
      previousHash,
    );
  }

  async getHead(streamId: string): Promise<AuditStreamRecord | null> {
    return this.store.getHead(streamId);
  }

  async getRecord(
    streamId: string,
    sequence: number,
  ): Promise<AuditStreamRecord | null> {
    return this.store.getRecord(streamId, sequence);
  }

  async createCheckpoint(
    streamId: string,
  ): Promise<AuditStreamCheckpoint> {
    const head = await this.store.getHead(streamId);
    if (!head) {
      throw new Error(`No records in stream ${streamId}`);
    }

    const activeKeyId = await this.keyRegistry.getActiveKey();
    if (!activeKeyId) {
      throw new Error('No active audit key available');
    }

    return this.store.createCheckpoint(
      streamId,
      head.sequence,
      head.payloadHash,
      activeKeyId,
    );
  }

  async verifyChain(
    streamId: string,
    upToSequence?: number,
  ): Promise<{ valid: boolean; errors: AuditStreamVerifyResult[] }> {
    const errors: AuditStreamVerifyResult[] = [];
    let head = await this.store.getHead(streamId);

    if (!head) {
      return { valid: true, errors }; // Empty stream is valid
    }

    const targetSeq = upToSequence || head.sequence;

    for (let i = 1; i <= targetSeq; i++) {
      const record = await this.store.getRecord(streamId, i);
      if (!record) {
        errors.push({
          valid: false,
          reason: 'gap_in_sequence',
          details: {
            recordFound: false,
            sequenceValid: false,
            hashValid: false,
            signatureValid: false,
            keyAvailable: false,
          },
        });
        continue;
      }

      const prevHash = i === 1 ? '0' : (await this.store.getRecord(streamId, i - 1))?.payloadHash || '';
      const result = await this.store.verify(streamId, i, prevHash);

      if (!result.valid) {
        errors.push(result);
      }

      // Verify HMAC signature can be validated
      const key = await this.keyRegistry.getKey(record.keyId);
      if (!key) {
        errors.push({
          valid: false,
          reason: 'key_not_found',
          details: {
            recordFound: true,
            sequenceValid: true,
            hashValid: true,
            signatureValid: false,
            keyAvailable: false,
          },
        });
      }

      if (key?.revokedAt) {
        // Revoked keys are OK for historical verification, just flag it
        this.logger.warn(
          `Record ${streamId}:${i} signed with revoked key ${record.keyId}`,
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  async exportCheckpointForVerification(
    streamId: string,
  ): Promise<{ checkpoint: AuditStreamCheckpoint; records: AuditStreamRecord[] }> {
    const checkpoint = await this.store.getLatestCheckpoint(streamId);
    if (!checkpoint) {
      throw new Error(`No checkpoint for stream ${streamId}`);
    }

    // Export all records up to checkpoint for external verification
    const records: AuditStreamRecord[] = [];
    for (let i = 1; i <= checkpoint.sequence; i++) {
      const record = await this.store.getRecord(streamId, i);
      if (record) {
        records.push(record);
      }
    }

    return { checkpoint, records };
  }

  private sanitizePayload(payload: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(payload)) {
      // Skip sensitive fields
      if (
        key.toLowerCase().includes('secret') ||
        key.toLowerCase().includes('password') ||
        key.toLowerCase().includes('token')
      ) {
        continue;
      }

      // Recursively sanitize nested objects
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        sanitized[key] = this.sanitizePayload(value);
      } else if (Array.isArray(value)) {
        sanitized[key] = value.map((item) =>
          item && typeof item === 'object' ? this.sanitizePayload(item) : item,
        );
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }
}

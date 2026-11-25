import { Logger } from '@nestjs/common';
import { AuditStreamStore } from './audit-stream.store';
import {
  AuditStreamRecord,
  AuditStreamCheckpoint,
  AuditStreamAppendResult,
  AuditStreamVerifyResult,
} from '../audit-stream.types';

/**
 * In-memory audit stream store for testing and development only.
 * NOT suitable for production—data is lost on restart and cannot be
 * shared across replicas.
 */
export class InMemoryAuditStreamStore extends AuditStreamStore {
  private readonly logger = new Logger(InMemoryAuditStreamStore.name);
  private records = new Map<string, AuditStreamRecord[]>();
  private checkpoints = new Map<string, AuditStreamCheckpoint>();

  constructor() {
    super();
    this.logger.warn(
      'InMemoryAuditStreamStore initialized. This is not suitable for production.',
    );
  }

  async append(
    streamId: string,
    payloadHash: string,
    hmacSignature: string,
    keyId: string,
    previousHash: string,
  ): Promise<AuditStreamAppendResult> {
    const records = this.records.get(streamId) || [];
    const sequence = records.length + 1;

    const record: AuditStreamRecord = {
      streamId,
      sequence,
      previousHash,
      payloadHash,
      hmacSignature,
      keyId,
      timestamp: new Date(),
      createdAt: new Date(),
    };

    records.push(record);
    this.records.set(streamId, records);

    return { streamId, sequence, hash: payloadHash };
  }

  async getHead(streamId: string): Promise<AuditStreamRecord | null> {
    const records = this.records.get(streamId);
    return records?.[records.length - 1] || null;
  }

  async getRecord(
    streamId: string,
    sequence: number,
  ): Promise<AuditStreamRecord | null> {
    const records = this.records.get(streamId);
    return records?.find((r) => r.sequence === sequence) || null;
  }

  async createCheckpoint(
    streamId: string,
    sequence: number,
    headHash: string,
    keyId: string,
  ): Promise<AuditStreamCheckpoint> {
    const checkpoint: AuditStreamCheckpoint = {
      streamId,
      sequence,
      headHash,
      keyId,
      createdAt: new Date(),
    };

    this.checkpoints.set(streamId, checkpoint);
    return checkpoint;
  }

  async getLatestCheckpoint(
    streamId: string,
  ): Promise<AuditStreamCheckpoint | null> {
    return this.checkpoints.get(streamId) || null;
  }

  async verify(
    streamId: string,
    sequence: number,
    expectedPreviousHash: string,
  ): Promise<AuditStreamVerifyResult> {
    const record = await this.getRecord(streamId, sequence);

    if (!record) {
      return {
        valid: false,
        reason: 'record_not_found',
        details: {
          recordFound: false,
          sequenceValid: false,
          hashValid: false,
          signatureValid: false,
          keyAvailable: false,
        },
      };
    }

    const sequenceValid = sequence === record.sequence;
    const hashValid = expectedPreviousHash === record.previousHash;

    return {
      valid: sequenceValid && hashValid,
      reason:
        !sequenceValid
          ? 'sequence_mismatch'
          : !hashValid
            ? 'hash_mismatch'
            : undefined,
      details: {
        recordFound: true,
        sequenceValid,
        hashValid,
        signatureValid: !!record.hmacSignature,
        keyAvailable: !!record.keyId,
      },
    };
  }
}

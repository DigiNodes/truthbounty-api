import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { AuditStreamStore } from './audit-stream.store';
import { AuditStreamRecordEntity } from '../entities/audit-stream-record.entity';
import { AuditStreamCheckpointEntity } from '../entities/audit-stream-checkpoint.entity';
import {
  AuditStreamRecord,
  AuditStreamCheckpoint,
  AuditStreamAppendResult,
  AuditStreamVerifyResult,
} from '../audit-stream.types';

@Injectable()
export class DurableAuditStreamStore extends AuditStreamStore {
  private readonly logger = new Logger(DurableAuditStreamStore.name);

  constructor(
    @InjectRepository(AuditStreamRecordEntity)
    private readonly recordRepo: Repository<AuditStreamRecordEntity>,
    @InjectRepository(AuditStreamCheckpointEntity)
    private readonly checkpointRepo: Repository<AuditStreamCheckpointEntity>,
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async append(
    streamId: string,
    payloadHash: string,
    hmacSignature: string,
    keyId: string,
    previousHash: string,
  ): Promise<AuditStreamAppendResult> {
    return this.dataSource.transaction(async (manager) => {
      const recordRepo = manager.getRepository(AuditStreamRecordEntity);

      // Get the current head or start at sequence 0
      const head = await recordRepo.findOne({
        where: { streamId },
        order: { sequence: 'DESC' },
      });

      const nextSequence = head ? head.sequence + 1 : 1;
      const expectedPreviousHash = head ? head.payloadHash : '0';

      // Fail if previousHash doesn't match the chain
      if (previousHash !== expectedPreviousHash) {
        throw new Error(
          `Chain continuity violation: expected previousHash ${expectedPreviousHash}, got ${previousHash}`,
        );
      }

      // Insert the new record (unique constraint will catch duplicates)
      const record = recordRepo.create({
        streamId,
        sequence: nextSequence,
        previousHash,
        payloadHash,
        hmacSignature,
        keyId,
        timestamp: Date.now(),
        createdAt: new Date(),
      });

      const saved = await recordRepo.save(record);

      return {
        streamId,
        sequence: saved.sequence,
        hash: saved.payloadHash,
      };
    });
  }

  async getHead(streamId: string): Promise<AuditStreamRecord | null> {
    const record = await this.recordRepo.findOne({
      where: { streamId },
      order: { sequence: 'DESC' },
    });

    return record ? this.mapToRecord(record) : null;
  }

  async getRecord(
    streamId: string,
    sequence: number,
  ): Promise<AuditStreamRecord | null> {
    const record = await this.recordRepo.findOne({
      where: { streamId, sequence },
    });

    return record ? this.mapToRecord(record) : null;
  }

  async createCheckpoint(
    streamId: string,
    sequence: number,
    headHash: string,
    keyId: string,
  ): Promise<AuditStreamCheckpoint> {
    return this.dataSource.transaction(async (manager) => {
      const checkpointRepo = manager.getRepository(AuditStreamCheckpointEntity);

      const checkpoint = checkpointRepo.create({
        streamId,
        sequence,
        headHash,
        keyId,
        createdAt: new Date(),
      });

      const saved = await checkpointRepo.save(checkpoint);
      return this.mapToCheckpoint(saved);
    });
  }

  async getLatestCheckpoint(
    streamId: string,
  ): Promise<AuditStreamCheckpoint | null> {
    const checkpoint = await this.checkpointRepo.findOne({
      where: { streamId },
      order: { sequence: 'DESC' },
    });

    return checkpoint ? this.mapToCheckpoint(checkpoint) : null;
  }

  async verify(
    streamId: string,
    sequence: number,
    expectedPreviousHash: string,
  ): Promise<AuditStreamVerifyResult> {
    const record = await this.recordRepo.findOne({
      where: { streamId, sequence },
    });

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

  private mapToRecord(entity: AuditStreamRecordEntity): AuditStreamRecord {
    return {
      streamId: entity.streamId,
      sequence: entity.sequence,
      previousHash: entity.previousHash,
      payloadHash: entity.payloadHash,
      hmacSignature: entity.hmacSignature,
      keyId: entity.keyId,
      timestamp: new Date(entity.timestamp),
      createdAt: entity.createdAt,
    };
  }

  private mapToCheckpoint(
    entity: AuditStreamCheckpointEntity,
  ): AuditStreamCheckpoint {
    return {
      streamId: entity.streamId,
      sequence: entity.sequence,
      headHash: entity.headHash,
      keyId: entity.keyId,
      createdAt: entity.createdAt,
    };
  }
}

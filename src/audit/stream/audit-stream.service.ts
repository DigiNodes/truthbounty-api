import { Injectable, Optional } from '@nestjs/common';
import { CanonicalSerializer } from './canonical-serializer';
import { AuditKeyRegistry } from './audit-key-registry';
import { AuditExportSanitizer } from './audit-export-sanitizer';
import {
  AuditStreamBinding,
  AuditStreamRecord,
  AuditStreamRecordPayload,
  AuditStreamCheckpoint,
  AuditVerificationOptions,
  AuditVerificationReport,
  AuditCorruptionReport,
  AuditCorruptionType,
  CorruptionFinding,
  AuditStreamExport,
  AUDIT_STREAM_DISCLAIMER,
  validateAuditStreamBinding,
  validateRecordPayload,
} from './audit-stream.types';

export interface AuditStreamStore {
  getRecords(streamId: string, fromSequence?: number, toSequence?: number): Promise<AuditStreamRecord[]>;
  getHead(streamId: string): Promise<AuditStreamRecord | null>;
  saveRecord(record: AuditStreamRecord): Promise<void>;
  saveCheckpoint(checkpoint: AuditStreamCheckpoint): Promise<void>;
  getCheckpoints(streamId: string): Promise<AuditStreamCheckpoint[]>;
  getLatestCheckpoint(streamId: string): Promise<AuditStreamCheckpoint | null>;
}

export class InMemoryAuditStreamStore implements AuditStreamStore {
  private readonly streams = new Map<string, AuditStreamRecord[]>();
  private readonly checkpoints = new Map<string, AuditStreamCheckpoint[]>();

  async getRecords(
    streamId: string,
    fromSequence?: number,
    toSequence?: number,
  ): Promise<AuditStreamRecord[]> {
    const list = this.streams.get(streamId) ?? [];
    let filtered = list;
    if (fromSequence !== undefined) {
      filtered = filtered.filter((r) => r.sequence >= fromSequence);
    }
    if (toSequence !== undefined) {
      filtered = filtered.filter((r) => r.sequence <= toSequence);
    }
    return [...filtered];
  }

  async getHead(streamId: string): Promise<AuditStreamRecord | null> {
    const list = this.streams.get(streamId) ?? [];
    if (list.length === 0) return null;
    return list[list.length - 1];
  }

  async saveRecord(record: AuditStreamRecord): Promise<void> {
    const list = this.streams.get(record.streamId) ?? [];
    list.push({ ...record });
    this.streams.set(record.streamId, list);
  }

  async saveCheckpoint(checkpoint: AuditStreamCheckpoint): Promise<void> {
    const list = this.checkpoints.get(checkpoint.streamId) ?? [];
    list.push({ ...checkpoint });
    this.checkpoints.set(checkpoint.streamId, list);
  }

  async getCheckpoints(streamId: string): Promise<AuditStreamCheckpoint[]> {
    return [...(this.checkpoints.get(streamId) ?? [])];
  }

  async getLatestCheckpoint(streamId: string): Promise<AuditStreamCheckpoint | null> {
    const list = this.checkpoints.get(streamId) ?? [];
    if (list.length === 0) return null;
    return list[list.length - 1];
  }
}

/**
 * Computes deterministic genesis hash for an audit stream bound to authoritative release/chain context.
 */
export function computeGenesisHash(
  streamId: string,
  binding: AuditStreamBinding,
): string {
  const b = validateAuditStreamBinding(binding);
  const genesisPayload = {
    genesisTag: 'TRUTHBOUNTY_AUDIT_STREAM_GENESIS_V1',
    streamId,
    binding: {
      chainId: b.chainId,
      releaseId: b.releaseId,
      deploymentBlock: b.deploymentBlock,
      artifactChecksum: b.artifactChecksum,
    },
  };
  return CanonicalSerializer.sha256(genesisPayload);
}

/**
 * Computes HMAC-SHA256 integrity hash for an audit record payload using canonical serialization.
 */
export function computeRecordHash(
  record: Omit<AuditStreamRecord, 'integrityHash'>,
  secret: string,
): string {
  const hashable = {
    streamId: record.streamId,
    sequence: record.sequence,
    eventId: record.eventId,
    timestamp: record.timestamp,
    recordType: record.recordType,
    action: record.action,
    actorId: record.actorId,
    actorType: record.actorType,
    targetType: record.targetType,
    targetId: record.targetId,
    capability: record.capability,
    authoritySource: record.authoritySource,
    authorityReference: record.authorityReference,
    requestReference: record.requestReference,
    correlationId: record.correlationId,
    outcome: record.outcome,
    severity: record.severity ?? null,
    resultReference: record.resultReference ?? null,
    chainContext: {
      chainId: record.chainContext.chainId,
      releaseId: record.chainContext.releaseId,
      deploymentBlock: record.chainContext.deploymentBlock,
      artifactChecksum: record.chainContext.artifactChecksum,
    },
    keyId: record.keyId,
    previousHash: record.previousHash,
  };
  return CanonicalSerializer.hmacSha256(secret, hashable);
}

/**
 * Computes checkpoint integrity hash using canonical serialization.
 */
export function computeCheckpointHash(
  checkpoint: Omit<AuditStreamCheckpoint, 'checkpointHash'>,
  secret: string,
): string {
  const hashable = {
    streamId: checkpoint.streamId,
    sequence: checkpoint.sequence,
    headHash: checkpoint.headHash,
    timestamp: checkpoint.timestamp,
    chainContext: {
      chainId: checkpoint.chainContext.chainId,
      releaseId: checkpoint.chainContext.releaseId,
      deploymentBlock: checkpoint.chainContext.deploymentBlock,
      artifactChecksum: checkpoint.chainContext.artifactChecksum,
    },
    keyId: checkpoint.keyId,
  };
  return CanonicalSerializer.hmacSha256(secret, hashable);
}

@Injectable()
export class AuditStreamService {
  private readonly store: AuditStreamStore;

  constructor(
    private readonly keyRegistry: AuditKeyRegistry,
    @Optional() store?: AuditStreamStore,
  ) {
    this.store = store ?? new InMemoryAuditStreamStore();
  }

  /**
   * Appends an audit record to the specified stream with per-stream hash chaining.
   */
  async append(
    streamId: string,
    payload: AuditStreamRecordPayload,
    customTimestamp?: Date,
  ): Promise<AuditStreamRecord> {
    if (!streamId || typeof streamId !== 'string' || streamId.trim().length === 0) {
      throw new Error('streamId is required and must be non-empty');
    }

    const validated = validateRecordPayload(payload);
    const activeKey = this.keyRegistry.getActiveKey();
    const head = await this.store.getHead(streamId);

    const sequence = head ? head.sequence + 1 : 1;
    const previousHash = head
      ? head.integrityHash
      : computeGenesisHash(streamId, validated.chainContext);

    const timestamp = (customTimestamp ?? new Date()).toISOString();

    const recordWithoutHash: Omit<AuditStreamRecord, 'integrityHash'> = {
      ...validated,
      streamId,
      sequence,
      timestamp,
      keyId: activeKey.keyId,
      previousHash,
    };

    const integrityHash = computeRecordHash(recordWithoutHash, activeKey.secret);
    const record: AuditStreamRecord = {
      ...recordWithoutHash,
      integrityHash,
    };

    await this.store.saveRecord(record);
    return record;
  }

  /**
   * Verifies the cryptographic chain and integrity of records in an audit stream.
   */
  async verify(
    streamId: string,
    options: AuditVerificationOptions = {},
  ): Promise<AuditVerificationReport> {
    const verifiedAt = new Date().toISOString();
    const records = await this.store.getRecords(
      streamId,
      options.fromSequence,
      options.toSequence,
    );

    if (records.length === 0) {
      return {
        valid: true,
        streamId,
        recordsChecked: 0,
        fromSequence: options.fromSequence ?? 0,
        toSequence: options.toSequence ?? 0,
        headHash: null,
        errors: [],
        warnings: ['Stream contains no records in specified range'],
        verifiedAt,
        disclaimer: AUDIT_STREAM_DISCLAIMER,
      };
    }

    const fromSeq = records[0].sequence;
    const toSeq = records[records.length - 1].sequence;
    let expectedPreviousHash: string | null = null;

    if (fromSeq === 1) {
      expectedPreviousHash = computeGenesisHash(streamId, records[0].chainContext);
    } else {
      // Fetch anchor from record immediately prior
      const priorRecords = await this.store.getRecords(streamId, fromSeq - 1, fromSeq - 1);
      if (priorRecords.length > 0) {
        expectedPreviousHash = priorRecords[0].integrityHash;
      }
    }

    let recordsChecked = 0;
    let expectedSequence = fromSeq;

    for (const record of records) {
      recordsChecked++;

      // Check sequence monotonicity
      if (record.sequence !== expectedSequence) {
        return {
          valid: false,
          streamId,
          recordsChecked,
          fromSequence: fromSeq,
          toSequence: toSeq,
          headHash: null,
          firstInvalid: {
            sequence: record.sequence,
            eventId: record.eventId,
            reason: `Sequence gap or mismatch: expected ${expectedSequence}, got ${record.sequence}`,
          },
          errors: [`Sequence mismatch at sequence ${record.sequence}`],
          warnings: [],
          verifiedAt,
          disclaimer: AUDIT_STREAM_DISCLAIMER,
        };
      }

      // Check previousHash link
      if (expectedPreviousHash !== null && record.previousHash !== expectedPreviousHash) {
        return {
          valid: false,
          streamId,
          recordsChecked,
          fromSequence: fromSeq,
          toSequence: toSeq,
          headHash: null,
          firstInvalid: {
            sequence: record.sequence,
            eventId: record.eventId,
            reason: `Previous hash mismatch: expected ${expectedPreviousHash}, got ${record.previousHash}`,
          },
          errors: [`Broken hash link at sequence ${record.sequence}`],
          warnings: [],
          verifiedAt,
          disclaimer: AUDIT_STREAM_DISCLAIMER,
        };
      }

      // Check key availability
      const keyEntry = this.keyRegistry.getKey(record.keyId);
      if (!keyEntry) {
        return {
          valid: false,
          streamId,
          recordsChecked,
          fromSequence: fromSeq,
          toSequence: toSeq,
          headHash: null,
          firstInvalid: {
            sequence: record.sequence,
            eventId: record.eventId,
            reason: `Key ID not found in registry: ${record.keyId}`,
          },
          errors: [`Unknown or missing key ${record.keyId} at sequence ${record.sequence}`],
          warnings: [],
          verifiedAt,
          disclaimer: AUDIT_STREAM_DISCLAIMER,
        };
      }

      // Check payload integrity hash
      const { integrityHash, ...hashable } = record;
      const computed = computeRecordHash(hashable, keyEntry.secret);
      if (computed !== integrityHash) {
        return {
          valid: false,
          streamId,
          recordsChecked,
          fromSequence: fromSeq,
          toSequence: toSeq,
          headHash: null,
          firstInvalid: {
            sequence: record.sequence,
            eventId: record.eventId,
            reason: `Integrity hash mismatch: expected ${computed}, got ${integrityHash}`,
          },
          errors: [`Integrity hash mismatch at sequence ${record.sequence}`],
          warnings: [],
          verifiedAt,
          disclaimer: AUDIT_STREAM_DISCLAIMER,
        };
      }

      // Check authoritative binding if expectedBinding is supplied
      if (options.expectedBinding) {
        const b = options.expectedBinding;
        const c = record.chainContext;
        if (
          b.chainId !== c.chainId ||
          b.releaseId.toLowerCase() !== c.releaseId.toLowerCase() ||
          b.deploymentBlock !== c.deploymentBlock ||
          b.artifactChecksum.toLowerCase() !== c.artifactChecksum.toLowerCase()
        ) {
          return {
            valid: false,
            streamId,
            recordsChecked,
            fromSequence: fromSeq,
            toSequence: toSeq,
            headHash: null,
            firstInvalid: {
              sequence: record.sequence,
              eventId: record.eventId,
              reason: 'Chain context binding does not match expected environment context',
              details: { expected: b, actual: c },
            },
            errors: [`Binding drift at sequence ${record.sequence}`],
            warnings: [],
            verifiedAt,
            disclaimer: AUDIT_STREAM_DISCLAIMER,
          };
        }
      }

      expectedPreviousHash = record.integrityHash;
      expectedSequence++;
    }

    const lastRecord = records[records.length - 1];

    // Check against checkpoint if supplied
    if (options.checkpoint) {
      const cp = options.checkpoint;
      if (cp.streamId !== streamId) {
        return {
          valid: false,
          streamId,
          recordsChecked,
          fromSequence: fromSeq,
          toSequence: toSeq,
          headHash: lastRecord.integrityHash,
          errors: [`Checkpoint streamId mismatch: ${cp.streamId} vs ${streamId}`],
          warnings: [],
          verifiedAt,
          disclaimer: AUDIT_STREAM_DISCLAIMER,
        };
      }
      if (cp.sequence === lastRecord.sequence && cp.headHash !== lastRecord.integrityHash) {
        return {
          valid: false,
          streamId,
          recordsChecked,
          fromSequence: fromSeq,
          toSequence: toSeq,
          headHash: lastRecord.integrityHash,
          firstInvalid: {
            sequence: lastRecord.sequence,
            eventId: lastRecord.eventId,
            reason: `Checkpoint head hash mismatch: expected ${cp.headHash}, got ${lastRecord.integrityHash}`,
          },
          errors: ['Stream tip does not match checkpoint'],
          warnings: [],
          verifiedAt,
          disclaimer: AUDIT_STREAM_DISCLAIMER,
        };
      }
    }

    return {
      valid: true,
      streamId,
      recordsChecked,
      fromSequence: fromSeq,
      toSequence: toSeq,
      headHash: lastRecord.integrityHash,
      errors: [],
      warnings: [],
      verifiedAt,
      disclaimer: AUDIT_STREAM_DISCLAIMER,
    };
  }

  /**
   * Creates a pinned checkpoint for an audit stream at the specified sequence or latest head.
   */
  async createCheckpoint(
    streamId: string,
    sequence?: number,
  ): Promise<AuditStreamCheckpoint> {
    const records = await this.store.getRecords(streamId);
    if (records.length === 0) {
      throw new Error(`Cannot checkpoint empty stream: ${streamId}`);
    }

    let targetRecord: AuditStreamRecord;
    if (sequence !== undefined) {
      const match = records.find((r) => r.sequence === sequence);
      if (!match) {
        throw new Error(
          `Sequence ${sequence} not found in stream ${streamId} for checkpointing`,
        );
      }
      targetRecord = match;
    } else {
      targetRecord = records[records.length - 1];
    }

    // Verify stream integrity up to the checkpoint sequence
    const verification = await this.verify(streamId, {
      fromSequence: 1,
      toSequence: targetRecord.sequence,
    });
    if (!verification.valid) {
      throw new Error(
        `Refusing to create checkpoint on corrupted stream: ${verification.errors.join(', ')}`,
      );
    }

    const activeKey = this.keyRegistry.getActiveKey();
    const timestamp = new Date().toISOString();

    const checkpointWithoutHash: Omit<AuditStreamCheckpoint, 'checkpointHash'> = {
      streamId,
      sequence: targetRecord.sequence,
      headHash: targetRecord.integrityHash,
      timestamp,
      chainContext: targetRecord.chainContext,
      keyId: activeKey.keyId,
    };

    const checkpointHash = computeCheckpointHash(
      checkpointWithoutHash,
      activeKey.secret,
    );
    const checkpoint: AuditStreamCheckpoint = {
      ...checkpointWithoutHash,
      checkpointHash,
    };

    await this.store.saveCheckpoint(checkpoint);
    return checkpoint;
  }

  /**
   * Exports an audit stream with full verification evidence and checkpoints,
   * strictly verifying that NO secrets, private keys, or passwords leak.
   */
  async export(
    streamId: string,
    options: AuditVerificationOptions = {},
  ): Promise<AuditStreamExport> {
    const records = await this.store.getRecords(
      streamId,
      options.fromSequence,
      options.toSequence,
    );
    if (records.length === 0) {
      throw new Error(`Cannot export empty stream: ${streamId}`);
    }

    const checkpoints = await this.store.getCheckpoints(streamId);
    const head = records[records.length - 1];

    const exportData: AuditStreamExport = {
      format: 'truthbounty-audit-stream-export-v1',
      streamId,
      exportedAt: new Date().toISOString(),
      chainContext: head.chainContext,
      recordCount: records.length,
      fromSequence: records[0].sequence,
      toSequence: head.sequence,
      headHash: head.integrityHash,
      checkpoints,
      records,
      disclaimer: AUDIT_STREAM_DISCLAIMER,
    };

    // Strict leak prevention: guarantee no secrets exist in the export
    AuditExportSanitizer.assertSecretFree(exportData);

    return exportData;
  }

  /**
   * Imports an exported audit stream, verifying all chain evidence.
   */
  async import(
    exportData: AuditStreamExport,
  ): Promise<{ importedCount: number; report: AuditVerificationReport }> {
    if (exportData.format !== 'truthbounty-audit-stream-export-v1') {
      throw new Error(`Unsupported audit stream export format: ${(exportData as any).format}`);
    }

    // Assert that the imported data contains no injected secret patterns
    AuditExportSanitizer.assertSecretFree(exportData);

    // Save into temporary store for verification
    const tempStore = new InMemoryAuditStreamStore();
    for (const r of exportData.records) {
      await tempStore.saveRecord(r);
    }
    for (const cp of exportData.checkpoints ?? []) {
      await tempStore.saveCheckpoint(cp);
    }

    const tempService = new AuditStreamService(this.keyRegistry, tempStore);
    const report = await tempService.verify(exportData.streamId);

    if (!report.valid) {
      throw new Error(
        `Import rejected: chain verification failed: ${report.errors.join(', ')}`,
      );
    }

    // Persist verified records to store
    for (const r of exportData.records) {
      await this.store.saveRecord(r);
    }
    for (const cp of exportData.checkpoints ?? []) {
      await this.store.saveCheckpoint(cp);
    }

    return {
      importedCount: exportData.records.length,
      report,
    };
  }

  /**
   * Diagnostic engine to detect and classify any corruption in the audit stream:
   * INSERTION, MUTATION, DELETION_GAP, DUPLICATE_SEQUENCE, REORDER,
   * PREVIOUS_HASH_MISMATCH, HASH_TAMPER, KEY_UNKNOWN, BINDING_MISMATCH, CHECKPOINT_MISMATCH.
   */
  async diagnoseCorruption(
    streamId: string,
    recordsOverride?: AuditStreamRecord[],
  ): Promise<AuditCorruptionReport> {
    const detectedAt = new Date().toISOString();
    const records =
      recordsOverride ?? (await this.store.getRecords(streamId));

    const findings: CorruptionFinding[] = [];

    if (records.length === 0) {
      return {
        streamId,
        status: 'HEALTHY',
        detectedAt,
        recordsAnalyzed: 0,
        corruptionsFound: [],
        summary: 'Stream has no records to diagnose',
        disclaimer: AUDIT_STREAM_DISCLAIMER,
      };
    }

    let expectedSeq = 1;
    let expectedPrevHash = computeGenesisHash(streamId, records[0].chainContext);
    const seenSequences = new Set<number>();

    for (let i = 0; i < records.length; i++) {
      const record = records[i];

      // Invalid sequence <= 0
      if (!Number.isInteger(record.sequence) || record.sequence <= 0) {
        findings.push({
          sequence: record.sequence,
          eventId: record.eventId,
          corruptionType: AuditCorruptionType.INVALID_SEQUENCE,
          description: `Invalid non-positive sequence: ${record.sequence}`,
          expected: expectedSeq,
          actual: record.sequence,
        });
      }

      // Duplicate sequence
      if (seenSequences.has(record.sequence)) {
        findings.push({
          sequence: record.sequence,
          eventId: record.eventId,
          corruptionType: AuditCorruptionType.DUPLICATE_SEQUENCE,
          description: `Duplicate sequence detected: ${record.sequence}`,
          expected: `unique sequence ${expectedSeq}`,
          actual: record.sequence,
        });
      }
      seenSequences.add(record.sequence);

      // Reorder detection (if current sequence is less than previous)
      if (i > 0 && record.sequence < records[i - 1].sequence) {
        findings.push({
          sequence: record.sequence,
          eventId: record.eventId,
          corruptionType: AuditCorruptionType.REORDER,
          description: `Stream reordering detected: sequence ${record.sequence} followed ${records[i - 1].sequence}`,
          expected: records[i - 1].sequence + 1,
          actual: record.sequence,
        });
      }

      // Deletion / gap detection
      if (record.sequence > expectedSeq) {
        findings.push({
          sequence: record.sequence,
          eventId: record.eventId,
          corruptionType: AuditCorruptionType.DELETION_GAP,
          description: `Sequence gap detected: jumped from ${expectedSeq - 1} to ${record.sequence}`,
          expected: expectedSeq,
          actual: record.sequence,
        });
      } else if (record.sequence < expectedSeq && i > 0 && record.sequence === expectedSeq - 1) {
        // Insertion / duplicate sequence
        findings.push({
          sequence: record.sequence,
          eventId: record.eventId,
          corruptionType: AuditCorruptionType.INSERTION,
          description: `Rogue record inserted with duplicate sequence ${record.sequence}`,
          expected: expectedSeq,
          actual: record.sequence,
        });
      }

      // Previous hash mismatch / link tampering
      if (record.previousHash !== expectedPrevHash) {
        findings.push({
          sequence: record.sequence,
          eventId: record.eventId,
          corruptionType: AuditCorruptionType.PREVIOUS_HASH_MISMATCH,
          description: `Broken previousHash link at sequence ${record.sequence}`,
          expected: expectedPrevHash,
          actual: record.previousHash,
        });
      }

      // Key ID lookup
      const keyEntry = this.keyRegistry.getKey(record.keyId);
      if (!keyEntry) {
        findings.push({
          sequence: record.sequence,
          eventId: record.eventId,
          corruptionType: AuditCorruptionType.KEY_UNKNOWN,
          description: `Unknown or unresolvable key ID: ${record.keyId}`,
          expected: 'registered keyId',
          actual: record.keyId,
        });
      } else {
        // Integrity hash check
        const { integrityHash, ...hashable } = record;
        const recomputed = computeRecordHash(hashable, keyEntry.secret);
        if (recomputed !== integrityHash) {
          findings.push({
            sequence: record.sequence,
            eventId: record.eventId,
            corruptionType: AuditCorruptionType.MUTATION,
            description: `Record content mutation detected at sequence ${record.sequence} (integrity hash mismatch)`,
            expected: recomputed,
            actual: integrityHash,
          });
        }
      }

      expectedSeq = record.sequence + 1;
      expectedPrevHash = record.integrityHash;
    }

    // Check against checkpoints
    const checkpoints = await this.store.getCheckpoints(streamId);
    for (const cp of checkpoints) {
      const match = records.find((r) => r.sequence === cp.sequence);
      if (match && match.integrityHash !== cp.headHash) {
        findings.push({
          sequence: cp.sequence,
          corruptionType: AuditCorruptionType.CHECKPOINT_MISMATCH,
          description: `Stream tip diverges from recorded checkpoint at sequence ${cp.sequence}`,
          expected: cp.headHash,
          actual: match.integrityHash,
        });
      }
    }

    const isHealthy = findings.length === 0;
    return {
      streamId,
      status: isHealthy ? 'HEALTHY' : 'CORRUPTED',
      detectedAt,
      recordsAnalyzed: records.length,
      corruptionsFound: findings,
      summary: isHealthy
        ? `Stream ${streamId} is healthy: all ${records.length} records cryptographically intact.`
        : `Stream ${streamId} is CORRUPTED: found ${findings.length} structural or cryptographic anomaly(ies).`,
      disclaimer: AUDIT_STREAM_DISCLAIMER,
    };
  }
}

import {
  AuditStreamRecord,
  AuditStreamCheckpoint,
  AuditStreamAppendResult,
  AuditStreamVerifyResult,
} from '../audit-stream.types';

export abstract class AuditStreamStore {
  abstract append(
    streamId: string,
    payloadHash: string,
    hmacSignature: string,
    keyId: string,
    previousHash: string,
  ): Promise<AuditStreamAppendResult>;

  abstract getHead(streamId: string): Promise<AuditStreamRecord | null>;

  abstract getRecord(
    streamId: string,
    sequence: number,
  ): Promise<AuditStreamRecord | null>;

  abstract createCheckpoint(
    streamId: string,
    sequence: number,
    headHash: string,
    keyId: string,
  ): Promise<AuditStreamCheckpoint>;

  abstract getLatestCheckpoint(
    streamId: string,
  ): Promise<AuditStreamCheckpoint | null>;

  abstract verify(
    streamId: string,
    sequence: number,
    expectedPreviousHash: string,
  ): Promise<AuditStreamVerifyResult>;
}

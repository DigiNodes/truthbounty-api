import { AuditStreamKey } from '../audit-stream.types';

export abstract class AuditKeyRegistry {
  abstract getActiveKey(): Promise<string | null>;

  abstract getKey(keyId: string): Promise<AuditStreamKey | null>;

  abstract rotateKey(newKeyId: string): Promise<void>;

  abstract revokeKey(keyId: string): Promise<void>;

  abstract listValidKeys(streamId: string): Promise<AuditStreamKey[]>;
}

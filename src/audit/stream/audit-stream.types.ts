export interface AuditStreamRecord {
  streamId: string;
  sequence: number;
  previousHash: string;
  payloadHash: string;
  hmacSignature: string;
  keyId: string;
  timestamp: Date;
  createdAt: Date;
}

export interface AuditStreamCheckpoint {
  streamId: string;
  sequence: number;
  headHash: string;
  keyId: string;
  createdAt: Date;
}

export interface AuditStreamAppendResult {
  streamId: string;
  sequence: number;
  hash: string;
}

export interface AuditStreamVerifyResult {
  valid: boolean;
  reason?: string;
  details?: {
    recordFound: boolean;
    sequenceValid: boolean;
    hashValid: boolean;
    signatureValid: boolean;
    keyAvailable: boolean;
  };
}

export interface AuditStreamKey {
  keyId: string;
  algorithm: string;
  createdAt: Date;
  revokedAt?: Date;
  isActive: boolean;
}

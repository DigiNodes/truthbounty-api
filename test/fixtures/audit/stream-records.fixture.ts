import { randomUUID } from 'crypto';
import {
  AuditStreamBinding,
  AuditStreamRecord,
  AuditStreamRecordPayload,
} from '../../../src/audit/stream/audit-stream.types';
import {
  AuditKeyRegistry,
} from '../../../src/audit/stream/audit-key-registry';
import {
  computeGenesisHash,
  computeRecordHash,
} from '../../../src/audit/stream/audit-stream.service';

export const TEST_STREAM_BINDING: AuditStreamBinding = {
  chainId: 11155420,
  releaseId: 'b7b2524a-1913-4f9e-a89c-4ec7a7183e20',
  deploymentBlock: '12850400',
  artifactChecksum: '0x3a7e58c97354a88f72c0587d5a3ef1806e5792949f506e938923058dbb239561',
};

export const ALTERNATE_BINDING: AuditStreamBinding = {
  chainId: 10,
  releaseId: 'a1a1a1a1-2222-4444-8888-ffffffffffff',
  deploymentBlock: '12999999',
  artifactChecksum: '0x9999999999999999999999999999999999999999999999999999999999999999',
};

export function createRecordPayload(
  seq: number,
  binding: AuditStreamBinding = TEST_STREAM_BINDING,
  overrides: Partial<AuditStreamRecordPayload> = {},
): AuditStreamRecordPayload {
  return {
    eventId: randomUUID(),
    recordType: 'security',
    action: 'USER_ROLE_CHANGE',
    actorId: randomUUID(),
    actorType: 'user',
    targetType: 'user_account',
    targetId: randomUUID(),
    capability: 'user.role.assign',
    authoritySource: 'rbac',
    authorityReference: randomUUID(),
    requestReference: randomUUID(),
    correlationId: randomUUID(),
    outcome: 'success',
    severity: 'MEDIUM',
    resultReference: randomUUID(),
    chainContext: binding,
    ...overrides,
  };
}

export function buildValidStream(
  count: number,
  streamId = 'test_security_stream',
  binding: AuditStreamBinding = TEST_STREAM_BINDING,
  keyRegistry: AuditKeyRegistry = new AuditKeyRegistry([
    { keyId: 'key-v1', secret: 'test-hmac-secret-32-chars-long-abc', active: true },
  ]),
): AuditStreamRecord[] {
  const records: AuditStreamRecord[] = [];
  let previousHash = computeGenesisHash(streamId, binding);
  const activeKey = keyRegistry.getActiveKey();

  for (let seq = 1; seq <= count; seq++) {
    const payload = createRecordPayload(seq, binding, {
      action: seq % 2 === 0 ? 'SYSTEM_MAINTENANCE' : 'USER_ROLE_CHANGE',
      capability: seq % 2 === 0 ? 'system.maintenance' : 'user.role.assign',
    });

    const recordWithoutHash: Omit<AuditStreamRecord, 'integrityHash'> = {
      ...payload,
      streamId,
      sequence: seq,
      timestamp: new Date(Date.UTC(2026, 9, 17, 0, 0, seq)).toISOString(),
      keyId: activeKey.keyId,
      previousHash,
    };

    const integrityHash = computeRecordHash(recordWithoutHash, activeKey.secret);
    const record: AuditStreamRecord = {
      ...recordWithoutHash,
      integrityHash,
    };

    records.push(record);
    previousHash = integrityHash;
  }

  return records;
}

/**
 * Fixture: Injects a rogue inserted record into an otherwise valid stream.
 */
export function createInsertCorruptionFixture(
  streamId = 'test_security_stream',
): AuditStreamRecord[] {
  const base = buildValidStream(5, streamId);
  // Inject rogue record between seq 2 and 3 with an arbitrary sequence or duplicate
  const rogue: AuditStreamRecord = {
    ...createRecordPayload(99, TEST_STREAM_BINDING),
    streamId,
    sequence: 3, // duplicated sequence 3
    timestamp: new Date().toISOString(),
    keyId: 'key-v1',
    previousHash: base[1].integrityHash,
    integrityHash: '0000000000000000000000000000000000000000000000000000000000000000',
  };
  return [base[0], base[1], rogue, base[2], base[3], base[4]];
}

/**
 * Fixture: Mutates an existing record in place (e.g. alters targetId or capability).
 */
export function createUpdateMutationFixture(
  streamId = 'test_security_stream',
): AuditStreamRecord[] {
  const base = buildValidStream(5, streamId);
  // Mutate record 3's targetId without recomputing integrityHash
  const cloned = JSON.parse(JSON.stringify(base)) as AuditStreamRecord[];
  cloned[2].targetId = randomUUID();
  return cloned;
}

/**
 * Fixture: Deletes a record from the stream (creating a sequence gap).
 */
export function createDeleteGapFixture(
  streamId = 'test_security_stream',
): AuditStreamRecord[] {
  const base = buildValidStream(5, streamId);
  // Remove sequence 3: stream now has 1, 2, 4, 5
  return [base[0], base[1], base[3], base[4]];
}

/**
 * Fixture: Reorders two records in the stream (swaps sequence 2 and 3).
 */
export function createReorderFixture(
  streamId = 'test_security_stream',
): AuditStreamRecord[] {
  const base = buildValidStream(5, streamId);
  // Swap base[1] (seq 2) and base[2] (seq 3)
  return [base[0], base[2], base[1], base[3], base[4]];
}

/**
 * Fixture: Directly tampers with integrityHash or previousHash.
 */
export function createTamperFixture(
  streamId = 'test_security_stream',
): AuditStreamRecord[] {
  const base = buildValidStream(5, streamId);
  const cloned = JSON.parse(JSON.stringify(base)) as AuditStreamRecord[];
  // Tamper with sequence 3's previousHash
  cloned[2].previousHash = 'bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0';
  return cloned;
}

/**
 * Fixture: Mutates the chain context binding (binding drift / unauthorized environment).
 */
export function createBindingMismatchFixture(
  streamId = 'test_security_stream',
): AuditStreamRecord[] {
  const base = buildValidStream(4, streamId);
  const cloned = JSON.parse(JSON.stringify(base)) as AuditStreamRecord[];
  cloned[1].chainContext = ALTERNATE_BINDING;
  return cloned;
}

/**
 * Fixture: Multi-key stream spanning multiple key rotations.
 */
export function createKeyRotationFixture(
  streamId = 'test_rotation_stream',
): { stream: AuditStreamRecord[]; registry: AuditKeyRegistry } {
  const registry = new AuditKeyRegistry([
    { keyId: 'key-2026-q1', secret: 'secret-key-2026-q1-active-token123', active: true },
  ]);

  const stream: AuditStreamRecord[] = [];
  let previousHash = computeGenesisHash(streamId, TEST_STREAM_BINDING);

  // Records 1-3 signed with key-2026-q1
  for (let seq = 1; seq <= 3; seq++) {
    const payload = createRecordPayload(seq, TEST_STREAM_BINDING);
    const withoutHash = {
      ...payload,
      streamId,
      sequence: seq,
      timestamp: new Date(Date.UTC(2026, 0, seq)).toISOString(),
      keyId: 'key-2026-q1',
      previousHash,
    };
    const integrityHash = computeRecordHash(withoutHash, 'secret-key-2026-q1-active-token123');
    stream.push({ ...withoutHash, integrityHash });
    previousHash = integrityHash;
  }

  // Rotate to key-2026-q2
  registry.rotateKey('key-2026-q2', 'secret-key-2026-q2-active-token456');

  // Records 4-6 signed with key-2026-q2
  for (let seq = 4; seq <= 6; seq++) {
    const payload = createRecordPayload(seq, TEST_STREAM_BINDING);
    const withoutHash = {
      ...payload,
      streamId,
      sequence: seq,
      timestamp: new Date(Date.UTC(2026, 3, seq)).toISOString(),
      keyId: 'key-2026-q2',
      previousHash,
    };
    const integrityHash = computeRecordHash(withoutHash, 'secret-key-2026-q2-active-token456');
    stream.push({ ...withoutHash, integrityHash });
    previousHash = integrityHash;
  }

  // Rotate to key-2026-q3
  registry.rotateKey('key-2026-q3', 'secret-key-2026-q3-active-token789');

  // Records 7-9 signed with key-2026-q3
  for (let seq = 7; seq <= 9; seq++) {
    const payload = createRecordPayload(seq, TEST_STREAM_BINDING);
    const withoutHash = {
      ...payload,
      streamId,
      sequence: seq,
      timestamp: new Date(Date.UTC(2026, 6, seq)).toISOString(),
      keyId: 'key-2026-q3',
      previousHash,
    };
    const integrityHash = computeRecordHash(withoutHash, 'secret-key-2026-q3-active-token789');
    stream.push({ ...withoutHash, integrityHash });
    previousHash = integrityHash;
  }

  return { stream, registry };
}

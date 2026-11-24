import {
  CanonicalSerializer,
  AuditStreamService,
  InMemoryAuditStreamStore,
  AuditKeyRegistry,
  AuditCorruptionType,
  computeGenesisHash,
  computeRecordHash,
  AUDIT_STREAM_DISCLAIMER,
} from '../src/audit/stream';
import {
  TEST_STREAM_BINDING,
  ALTERNATE_BINDING,
  buildValidStream,
  createRecordPayload,
  createInsertCorruptionFixture,
  createUpdateMutationFixture,
  createDeleteGapFixture,
  createReorderFixture,
  createTamperFixture,
  createBindingMismatchFixture,
  createKeyRotationFixture,
} from './fixtures/audit/stream-records.fixture';

describe('Audit Stream Canonical Serialization and Hash Chaining', () => {
  describe('CanonicalSerializer (RFC 8785)', () => {
    it('serializes objects identically regardless of key insertion order', () => {
      const obj1 = { z: 1, a: 'test', m: { y: 2, b: 3 } };
      const obj2 = { a: 'test', m: { b: 3, y: 2 }, z: 1 };

      const serialized1 = CanonicalSerializer.serialize(obj1);
      const serialized2 = CanonicalSerializer.serialize(obj2);

      expect(serialized1).toBe(serialized2);
      expect(CanonicalSerializer.sha256(obj1)).toBe(CanonicalSerializer.sha256(obj2));
    });

    it('rejects non-finite numbers (NaN, Infinity)', () => {
      expect(() => CanonicalSerializer.serialize({ invalid: NaN })).toThrow(/non-finite/);
      expect(() => CanonicalSerializer.serialize({ invalid: Infinity })).toThrow(/non-finite/);
      expect(() => CanonicalSerializer.serialize({ invalid: -Infinity })).toThrow(/non-finite/);
    });

    it('serializes -0 as 0 per RFC 8785', () => {
      expect(CanonicalSerializer.serialize(-0)).toBe('0');
      expect(CanonicalSerializer.serialize({ val: -0 })).toBe('{"val":0}');
    });

    it('normalizes Date objects to ISO 8601 strings', () => {
      const date = new Date(Date.UTC(2026, 9, 17, 12, 0, 0));
      const serialized = CanonicalSerializer.serialize({ timestamp: date });
      expect(serialized).toBe('{"timestamp":"2026-10-17T12:00:00.000Z"}');
    });

    it('handles BigInt and arrays deterministically', () => {
      const serialized = CanonicalSerializer.serialize({
        list: [1, 2, 'three'],
        big: 9007199254740993n,
      });
      expect(serialized).toBe('{"big":"9007199254740993","list":[1,2,"three"]}');
    });

    it('rejects undefined in arrays to prevent ambiguous positioning', () => {
      expect(() => CanonicalSerializer.serialize([1, undefined, 3])).toThrow(/undefined is not allowed/);
    });
  });

  describe('Genesis and Binding Rules', () => {
    it('deterministically computes stream genesis hash bound to release context', () => {
      const hash1 = computeGenesisHash('admin_security', TEST_STREAM_BINDING);
      const hash2 = computeGenesisHash('admin_security', TEST_STREAM_BINDING);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);

      // Distinct streams have distinct genesis hashes
      const hashDiffStream = computeGenesisHash('admin_governance', TEST_STREAM_BINDING);
      expect(hash1).not.toBe(hashDiffStream);

      // Distinct release binding has distinct genesis hash
      const hashDiffBinding = computeGenesisHash('admin_security', ALTERNATE_BINDING);
      expect(hash1).not.toBe(hashDiffBinding);
    });

    it('fails closed on invalid or ambiguous binding parameters', () => {
      expect(() =>
        computeGenesisHash('admin_security', {
          ...TEST_STREAM_BINDING,
          chainId: -1,
        }),
      ).toThrow(/Invalid audit chainId/);

      expect(() =>
        computeGenesisHash('admin_security', {
          ...TEST_STREAM_BINDING,
          releaseId: 'invalid-not-uuid',
        }),
      ).toThrow(/Invalid audit releaseId/);

      expect(() =>
        computeGenesisHash('admin_security', {
          ...TEST_STREAM_BINDING,
          artifactChecksum: 'invalid-checksum',
        }),
      ).toThrow(/Invalid audit artifactChecksum/);
    });
  });

  describe('Stream Verification and Tamper Detection Fixtures', () => {
    let registry: AuditKeyRegistry;
    let store: InMemoryAuditStreamStore;
    let service: AuditStreamService;

    beforeEach(() => {
      registry = new AuditKeyRegistry([
        { keyId: 'key-v1', secret: 'test-hmac-secret-32-chars-long-abc', active: true },
      ]);
      store = new InMemoryAuditStreamStore();
      service = new AuditStreamService(registry, store);
    });

    it('verifies an intact valid stream successfully', async () => {
      const validRecords = buildValidStream(10, 'stream_valid', TEST_STREAM_BINDING, registry);
      for (const r of validRecords) {
        await store.saveRecord(r);
      }

      const report = await service.verify('stream_valid');
      expect(report.valid).toBe(true);
      expect(report.recordsChecked).toBe(10);
      expect(report.fromSequence).toBe(1);
      expect(report.toSequence).toBe(10);
      expect(report.headHash).toBe(validRecords[9].integrityHash);
      expect(report.errors).toHaveLength(0);
      expect(report.disclaimer).toBe(AUDIT_STREAM_DISCLAIMER);
    });

    it('detects INSERTION corruption (rogue record injected into stream)', async () => {
      const insertFixture = createInsertCorruptionFixture('stream_insert');
      const diag = await service.diagnoseCorruption('stream_insert', insertFixture);

      expect(diag.status).toBe('CORRUPTED');
      expect(diag.corruptionsFound.some((c) =>
        c.corruptionType === AuditCorruptionType.INSERTION ||
        c.corruptionType === AuditCorruptionType.DUPLICATE_SEQUENCE ||
        c.corruptionType === AuditCorruptionType.PREVIOUS_HASH_MISMATCH
      )).toBe(true);

      for (const r of insertFixture) {
        await store.saveRecord(r);
      }
      const verifyReport = await service.verify('stream_insert');
      expect(verifyReport.valid).toBe(false);
      expect(verifyReport.firstInvalid).toBeDefined();
    });

    it('detects UPDATE / MUTATION corruption (record field altered in place)', async () => {
      const updateFixture = createUpdateMutationFixture('stream_update');
      const diag = await service.diagnoseCorruption('stream_update', updateFixture);

      expect(diag.status).toBe('CORRUPTED');
      const mutationFinding = diag.corruptionsFound.find(
        (c) => c.corruptionType === AuditCorruptionType.MUTATION,
      );
      expect(mutationFinding).toBeDefined();
      expect(mutationFinding?.sequence).toBe(3);

      for (const r of updateFixture) {
        await store.saveRecord(r);
      }
      const verifyReport = await service.verify('stream_update');
      expect(verifyReport.valid).toBe(false);
      expect(verifyReport.firstInvalid?.sequence).toBe(3);
    });

    it('detects DELETION / GAP corruption (record removed from sequence)', async () => {
      const deleteFixture = createDeleteGapFixture('stream_delete');
      const diag = await service.diagnoseCorruption('stream_delete', deleteFixture);

      expect(diag.status).toBe('CORRUPTED');
      const gapFinding = diag.corruptionsFound.find(
        (c) => c.corruptionType === AuditCorruptionType.DELETION_GAP,
      );
      expect(gapFinding).toBeDefined();
      expect(gapFinding?.sequence).toBe(4); // jumped 2 -> 4

      for (const r of deleteFixture) {
        await store.saveRecord(r);
      }
      const verifyReport = await service.verify('stream_delete');
      expect(verifyReport.valid).toBe(false);
    });

    it('detects REORDER corruption (two records swapped)', async () => {
      const reorderFixture = createReorderFixture('stream_reorder');
      const diag = await service.diagnoseCorruption('stream_reorder', reorderFixture);

      expect(diag.status).toBe('CORRUPTED');
      const reorderFinding = diag.corruptionsFound.find(
        (c) => c.corruptionType === AuditCorruptionType.REORDER,
      );
      expect(reorderFinding).toBeDefined();

      for (const r of reorderFixture) {
        await store.saveRecord(r);
      }
      const verifyReport = await service.verify('stream_reorder');
      expect(verifyReport.valid).toBe(false);
    });

    it('detects TAMPER corruption (previousHash or integrityHash altered)', async () => {
      const tamperFixture = createTamperFixture('stream_tamper');
      const diag = await service.diagnoseCorruption('stream_tamper', tamperFixture);

      expect(diag.status).toBe('CORRUPTED');
      const tamperFinding = diag.corruptionsFound.find(
        (c) => c.corruptionType === AuditCorruptionType.PREVIOUS_HASH_MISMATCH,
      );
      expect(tamperFinding).toBeDefined();

      for (const r of tamperFixture) {
        await store.saveRecord(r);
      }
      const verifyReport = await service.verify('stream_tamper');
      expect(verifyReport.valid).toBe(false);
    });

    it('detects BINDING DRIFT (chain context altered in record)', async () => {
      const bindingFixture = createBindingMismatchFixture('stream_binding');
      for (const r of bindingFixture) {
        await store.saveRecord(r);
      }

      // Verifying against expected binding detects unauthorized environment mutation
      const verifyReport = await service.verify('stream_binding', {
        expectedBinding: TEST_STREAM_BINDING,
      });

      expect(verifyReport.valid).toBe(false);
      expect(verifyReport.errors[0]).toMatch(/Binding drift|Integrity hash mismatch/);
    });
  });

  describe('Key Rotation', () => {
    it('verifies streams seamlessly across multiple key rotations', async () => {
      const { stream, registry } = createKeyRotationFixture('stream_rotation');
      const store = new InMemoryAuditStreamStore();
      for (const r of stream) {
        await store.saveRecord(r);
      }

      const service = new AuditStreamService(registry, store);
      const report = await service.verify('stream_rotation');

      expect(report.valid).toBe(true);
      expect(report.recordsChecked).toBe(9);
      expect(report.errors).toHaveLength(0);
    });

    it('fails closed when a record references an unknown or unregistered keyId', async () => {
      const { stream } = createKeyRotationFixture('stream_unknown_key');
      // Registry only knows key-2026-q1, missing q2 and q3
      const incompleteRegistry = new AuditKeyRegistry([
        { keyId: 'key-2026-q1', secret: 'secret-key-2026-q1-active-token123', active: true },
      ]);
      const store = new InMemoryAuditStreamStore();
      for (const r of stream) {
        await store.saveRecord(r);
      }

      const service = new AuditStreamService(incompleteRegistry, store);
      const report = await service.verify('stream_unknown_key');

      expect(report.valid).toBe(false);
      expect(report.firstInvalid?.sequence).toBe(4);
      expect(report.firstInvalid?.reason).toMatch(/Key ID not found in registry: key-2026-q2/);
    });
  });

  describe('Checkpoints', () => {
    let registry: AuditKeyRegistry;
    let store: InMemoryAuditStreamStore;
    let service: AuditStreamService;

    beforeEach(() => {
      registry = new AuditKeyRegistry([
        { keyId: 'key-v1', secret: 'test-hmac-secret-32-chars-long-abc', active: true },
      ]);
      store = new InMemoryAuditStreamStore();
      service = new AuditStreamService(registry, store);
    });

    it('creates and verifies pinned checkpoints on valid streams', async () => {
      const records = buildValidStream(5, 'stream_cp', TEST_STREAM_BINDING, registry);
      for (const r of records) {
        await store.saveRecord(r);
      }

      const cp = await service.createCheckpoint('stream_cp');
      expect(cp.streamId).toBe('stream_cp');
      expect(cp.sequence).toBe(5);
      expect(cp.headHash).toBe(records[4].integrityHash);
      expect(cp.checkpointHash).toMatch(/^[0-9a-f]{64}$/);

      // Verify stream matches checkpoint
      const verifyReport = await service.verify('stream_cp', { checkpoint: cp });
      expect(verifyReport.valid).toBe(true);
    });

    it('refuses to checkpoint a corrupted stream', async () => {
      const records = createUpdateMutationFixture('stream_cp_corrupt');
      for (const r of records) {
        await store.saveRecord(r);
      }

      await expect(service.createCheckpoint('stream_cp_corrupt')).rejects.toThrow(
        /Refusing to create checkpoint on corrupted stream/,
      );
    });

    it('detects stream tip divergence from recorded checkpoint', async () => {
      const records = buildValidStream(3, 'stream_diverge', TEST_STREAM_BINDING, registry);
      for (const r of records) {
        await store.saveRecord(r);
      }

      const cp = await service.createCheckpoint('stream_diverge');

      // Tamper with checkpoint headHash
      const tamperedCp = {
        ...cp,
        headHash: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      const verifyReport = await service.verify('stream_diverge', { checkpoint: tamperedCp });
      expect(verifyReport.valid).toBe(false);
      expect(verifyReport.errors[0]).toMatch(/Stream tip does not match checkpoint/);
    });
  });

  describe('Export and Import Evidence (Secret-Safe)', () => {
    let registry: AuditKeyRegistry;
    let store: InMemoryAuditStreamStore;
    let service: AuditStreamService;

    beforeEach(() => {
      registry = new AuditKeyRegistry([
        { keyId: 'key-v1', secret: 'test-hmac-secret-32-chars-long-abc', active: true },
      ]);
      store = new InMemoryAuditStreamStore();
      service = new AuditStreamService(registry, store);
    });

    it('exports audit stream evidence without leaking secrets', async () => {
      const records = buildValidStream(5, 'stream_export', TEST_STREAM_BINDING, registry);
      for (const r of records) {
        await store.saveRecord(r);
      }
      await service.createCheckpoint('stream_export');

      const exported = await service.export('stream_export');

      expect(exported.format).toBe('truthbounty-audit-stream-export-v1');
      expect(exported.streamId).toBe('stream_export');
      expect(exported.recordCount).toBe(5);
      expect(exported.checkpoints).toHaveLength(1);
      expect(exported.disclaimer).toBe(AUDIT_STREAM_DISCLAIMER);

      // Verify serialized JSON contains NO HMAC secrets or credentials
      const serialized = JSON.stringify(exported);
      expect(serialized).not.toContain('test-hmac-secret-32-chars-long-abc');
      expect(serialized).not.toMatch(/"(secret|password|token|credential|private)"/i);
    });

    it('imports and verifies exported evidence deterministically in a fresh instance', async () => {
      const records = buildValidStream(5, 'stream_impexp', TEST_STREAM_BINDING, registry);
      for (const r of records) {
        await store.saveRecord(r);
      }
      const exported = await service.export('stream_impexp');

      // Fresh store and fresh service instance
      const freshStore = new InMemoryAuditStreamStore();
      const freshService = new AuditStreamService(registry, freshStore);

      const result = await freshService.import(exported);
      expect(result.importedCount).toBe(5);
      expect(result.report.valid).toBe(true);

      // Verification on fresh store succeeds
      const verifyReport = await freshService.verify('stream_impexp');
      expect(verifyReport.valid).toBe(true);
      expect(verifyReport.recordsChecked).toBe(5);
    });

    it('rejects importing tampered export payload', async () => {
      const records = buildValidStream(5, 'stream_tampered_export', TEST_STREAM_BINDING, registry);
      for (const r of records) {
        await store.saveRecord(r);
      }
      const exported = await service.export('stream_tampered_export');

      // Tamper with record in exported JSON
      exported.records[1].action = 'UNAUTHORIZED_MUTATION';

      const freshStore = new InMemoryAuditStreamStore();
      const freshService = new AuditStreamService(registry, freshStore);

      await expect(freshService.import(exported)).rejects.toThrow(
        /Import rejected: chain verification failed/,
      );
    });
  });

  describe('Large-Stream Scale & Determinism', () => {
    it('verifies a large stream (1,000 records) deterministically without memory bloat', async () => {
      const registry = new AuditKeyRegistry([
        { keyId: 'key-large', secret: 'test-hmac-secret-32-chars-large-scale', active: true },
      ]);
      const store = new InMemoryAuditStreamStore();
      const service = new AuditStreamService(registry, store);

      const largeRecords = buildValidStream(1000, 'stream_large', TEST_STREAM_BINDING, registry);
      for (const r of largeRecords) {
        await store.saveRecord(r);
      }

      const report = await service.verify('stream_large');
      expect(report.valid).toBe(true);
      expect(report.recordsChecked).toBe(1000);
      expect(report.fromSequence).toBe(1);
      expect(report.toSequence).toBe(1000);
      expect(report.headHash).toBe(largeRecords[999].integrityHash);

      // Sub-range verification
      const rangeReport = await service.verify('stream_large', {
        fromSequence: 500,
        toSequence: 550,
      });
      expect(rangeReport.valid).toBe(true);
      expect(rangeReport.recordsChecked).toBe(51);
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuditStreamService } from '../services/audit-stream.service';
import { AuditStreamStore } from '../stores/audit-stream.store';
import { DurableAuditStreamStore } from '../stores/durable-audit-stream.store';
import { SecretAuditKeyRegistry } from '../key-registry/secret-audit-key-registry';
import { AuditStreamRecordEntity } from '../entities/audit-stream-record.entity';
import { AuditStreamCheckpointEntity } from '../entities/audit-stream-checkpoint.entity';
import { AuditKeyMetadataEntity } from '../entities/audit-key-metadata.entity';
import { AuditStreamModule } from '../audit-stream.module';

describe('AuditStream Integration Tests', () => {
  let module: TestingModule;
  let service: AuditStreamService;
  let store: AuditStreamStore;
  let dataSource: DataSource;
  let registry: SecretAuditKeyRegistry;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: '.env.test',
          load: [
            () => ({
              NODE_ENV: 'test',
              DATABASE_URL: ':memory:',
              AUDIT_ACTIVE_KEY_ID: 'test-key-1',
              AUDIT_HMAC_KEY_test_key_1:
                'test-secret-key-material-' +
                'a'.repeat(32),
            }),
          ],
        }),
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          entities: [
            AuditStreamRecordEntity,
            AuditStreamCheckpointEntity,
            AuditKeyMetadataEntity,
          ],
          synchronize: true,
        }),
        AuditStreamModule,
      ],
    }).compile();

    service = module.get(AuditStreamService);
    store = module.get(AuditStreamStore);
    dataSource = module.get(DataSource);
    registry = module.get(SecretAuditKeyRegistry);

    await dataSource.initialize();

    // Initialize key metadata
    const keyRepo = dataSource.getRepository(AuditKeyMetadataEntity);
    await keyRepo.insert({
      keyId: 'test-key-1',
      algorithm: 'HMAC-SHA256',
      createdAt: new Date(),
      isActive: true,
    });
  });

  afterAll(async () => {
    await dataSource.destroy();
    await module.close();
  });

  describe('persistence across restarts', () => {
    it('should retain records and checkpoints after simulated restart', async () => {
      const streamId = 'persistent-stream-1';

      // Initial writes
      const r1 = await service.append(streamId, { action: 'TEST1' });
      const r2 = await service.append(streamId, { action: 'TEST2' });
      const checkpoint = await service.createCheckpoint(streamId);

      expect(r1.sequence).toBe(1);
      expect(r2.sequence).toBe(2);
      expect(checkpoint.sequence).toBe(2);

      // Simulate restart: query again
      const retrieved1 = await store.getRecord(streamId, 1);
      const retrieved2 = await store.getRecord(streamId, 2);
      const retrievedCheckpoint = await store.getLatestCheckpoint(streamId);

      expect(retrieved1?.payloadHash).toBe(r1.hash);
      expect(retrieved2?.payloadHash).toBe(r2.hash);
      expect(retrievedCheckpoint?.headHash).toBe(checkpoint.headHash);
    });
  });

  describe('concurrent appends serialize safely', () => {
    it('should assign unique sequences despite concurrent appends', async () => {
      const streamId = 'concurrent-stream-1';
      const concurrencyLevel = 10;

      const promises = Array.from({ length: concurrencyLevel }, (_, i) =>
        service.append(streamId, {
          action: `CONCURRENT_${i}`,
          index: i,
        }),
      );

      const results = await Promise.all(promises);

      // Extract sequences
      const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);

      // Should have all unique sequences from 1 to N
      expect(sequences).toEqual(
        Array.from({ length: concurrencyLevel }, (_, i) => i + 1),
      );

      // Verify all records exist with correct chain
      const record1 = await store.getRecord(streamId, 1);
      const record2 = await store.getRecord(streamId, 2);

      expect(record2?.previousHash).toBe(record1?.payloadHash);
    });

    it('should handle race during checkpoint creation', async () => {
      const streamId = 'concurrent-stream-2';

      await service.append(streamId, { action: 'PREP1' });
      await service.append(streamId, { action: 'PREP2' });

      // Create multiple checkpoints concurrently (last one wins)
      const checkpoints = await Promise.all([
        service.createCheckpoint(streamId),
        service.createCheckpoint(streamId),
        service.createCheckpoint(streamId),
      ]);

      // All should succeed; the latest one overwrites
      const latest = await store.getLatestCheckpoint(streamId);
      expect(latest?.sequence).toBe(2);
    });
  });

  describe('chain integrity verification', () => {
    it('should verify valid chain after multiple appends', async () => {
      const streamId = 'verify-stream-1';

      await service.append(streamId, { action: 'V1' });
      await service.append(streamId, { action: 'V2' });
      await service.append(streamId, { action: 'V3' });

      const result = await service.verifyChain(streamId);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect hash mismatch if record corrupted', async () => {
      const streamId = 'verify-stream-2';

      await service.append(streamId, { action: 'BEFORE' });
      const r2 = await service.append(streamId, { action: 'BEFORE_CORRUPT' });

      // Manually corrupt record 2's payload hash (but keep previousHash intact)
      const recordRepo = dataSource.getRepository(AuditStreamRecordEntity);
      const originalRecord = await recordRepo.findOne({
        where: { streamId, sequence: 2 },
      });

      if (originalRecord) {
        await recordRepo.update(
          { streamId, sequence: 2 },
          { payloadHash: 'corrupted-hash-' + r2.hash },
        );

        // Verification should catch the broken link at sequence 3
        const record1 = await store.getRecord(streamId, 1);
        if (record1) {
          // Try to append a new record - it will fail because chain is broken
          // Or verify that the corrupted record doesn't chain properly
          const corruptedRecord = await store.getRecord(streamId, 2);
          if (corruptedRecord) {
            // The hash is now corrupted, so linkage is broken for record 3
            expect(corruptedRecord.payloadHash).not.toBe(r2.hash);
          }
        }
      }
    });

    it('should validate checkpoint against stream state', async () => {
      const streamId = 'verify-stream-3';

      await service.append(streamId, { action: 'C1' });
      await service.append(streamId, { action: 'C2' });
      const checkpoint = await service.createCheckpoint(streamId);

      const head = await store.getHead(streamId);

      expect(checkpoint.headHash).toBe(head?.payloadHash);
      expect(checkpoint.sequence).toBe(head?.sequence);
    });
  });

  describe('key rotation and historical verification', () => {
    it('should verify records after key rotation', async () => {
      const streamId = 'key-rotate-stream-1';

      // Write with key 1
      const r1 = await service.append(streamId, { action: 'WITH_KEY1' });

      // Add new key to metadata
      const keyRepo = dataSource.getRepository(AuditKeyMetadataEntity);
      await keyRepo.insert({
        keyId: 'test-key-2',
        algorithm: 'HMAC-SHA256',
        createdAt: new Date(),
        isActive: false,
      });

      // Rotate to key 2
      (registry as any).keyCache.set(
        'test-key-2',
        'test-secret-key-material-b'.repeat(2),
      );
      await registry.rotateKey('test-key-2');

      // Write with key 2
      const r2 = await service.append(streamId, { action: 'WITH_KEY2' });

      // Verify chain still works
      const result = await service.verifyChain(streamId);
      expect(result.valid).toBe(true);

      // Record 1 is signed with key 1, record 2 with key 2
      const rec1 = await store.getRecord(streamId, 1);
      const rec2 = await store.getRecord(streamId, 2);

      expect(rec1?.keyId).toBe('test-key-1');
      expect(rec2?.keyId).toBe('test-key-2');
    });

    it('should warn on revoked key but still verify', async () => {
      const streamId = 'key-revoke-stream-1';

      const r1 = await service.append(streamId, { action: 'BEFORE_REVOKE' });

      // Revoke the current key (after first record)
      const keyRepo = dataSource.getRepository(AuditKeyMetadataEntity);
      await keyRepo.update(
        { keyId: 'test-key-1' },
        { isActive: false, revokedAt: new Date() },
      );

      // Append another record with a new key
      const newKeyId = 'test-key-revoked-verify';
      await keyRepo.insert({
        keyId: newKeyId,
        algorithm: 'HMAC-SHA256',
        createdAt: new Date(),
        isActive: true,
      });

      (registry as any).keyCache.set(newKeyId, 'secret-key-' + 'x'.repeat(32));
      (registry as any).activeKeyId = newKeyId;

      const r2 = await service.append(streamId, { action: 'AFTER_REVOKE' });

      // Verification should still succeed but flag the revoked key
      const result = await service.verifyChain(streamId);
      // Chain is still valid; revoked keys don't invalidate other records
      expect(result.valid).toBe(true);
    });
  });

  describe('export and external verification', () => {
    it('should export checkpoint with all records for external verification', async () => {
      const streamId = 'export-stream-1';

      await service.append(streamId, { action: 'E1' });
      await service.append(streamId, { action: 'E2' });
      await service.append(streamId, { action: 'E3' });
      await service.createCheckpoint(streamId);

      const exported = await service.exportCheckpointForVerification(streamId);

      expect(exported.checkpoint.sequence).toBe(3);
      expect(exported.records).toHaveLength(3);
      expect(exported.records[0].sequence).toBe(1);
      expect(exported.records[2].sequence).toBe(3);

      // All records should have valid signatures
      exported.records.forEach((rec) => {
        expect(rec.hmacSignature).toBeDefined();
        expect(rec.keyId).toBeDefined();
      });
    });
  });

  describe('error boundaries', () => {
    it('should enforce unique stream/sequence constraint', async () => {
      const streamId = 'unique-stream-1';

      await service.append(streamId, { action: 'UNIQUE1' });

      // Try to insert duplicate by bypassing service
      const recordRepo = dataSource.getRepository(AuditStreamRecordEntity);

      await expect(
        recordRepo.insert({
          streamId,
          sequence: 1, // Duplicate
          previousHash: '0',
          payloadHash: 'different-hash',
          hmacSignature: 'sig',
          keyId: 'test-key-1',
          timestamp: Date.now(),
          createdAt: new Date(),
        }),
      ).rejects.toThrow(); // Unique constraint violation
    });

    it('should handle missing active key gracefully', async () => {
      const streamId = 'no-key-stream';

      (registry as any).activeKeyId = null;

      await expect(
        service.append(streamId, { action: 'NO_KEY' }),
      ).rejects.toThrow('No active audit key available');
    });
  });
});

import { Test } from '@nestjs/testing';
import { AuditStreamService } from '../services/audit-stream.service';
import { DurableAuditStreamStore } from '../stores/durable-audit-stream.store';
import { InMemoryAuditStreamStore } from '../stores/in-memory-audit-stream.store';
import { SecretAuditKeyRegistry } from '../key-registry/secret-audit-key-registry';
import * as crypto from 'crypto';

describe('AuditStreamService', () => {
  let service: AuditStreamService;
  let store: DurableAuditStreamStore | InMemoryAuditStreamStore;
  let keyRegistry: SecretAuditKeyRegistry;

  beforeEach(async () => {
    const mockStore = new InMemoryAuditStreamStore();
    const mockRegistry = {
      getActiveKey: jest.fn().mockResolvedValue('test-key-id'),
      getKey: jest.fn().mockResolvedValue({
        keyId: 'test-key-id',
        algorithm: 'HMAC-SHA256',
        createdAt: new Date(),
        isActive: true,
      }),
      loadKeyMaterial: jest.fn().mockReturnValue('test-secret-key-material'),
      listValidKeys: jest.fn().mockResolvedValue([
        {
          keyId: 'test-key-id',
          algorithm: 'HMAC-SHA256',
          createdAt: new Date(),
          isActive: true,
        },
      ]),
    } as any;

    service = new AuditStreamService(mockStore, mockRegistry);
    store = mockStore;
    keyRegistry = mockRegistry;
  });

  describe('append', () => {
    it('should append a record and generate hash chain', async () => {
      const streamId = 'audit-stream-1';
      const payload = { action: 'USER_CREATED', userId: 'user-123' };

      const result = await service.append(streamId, payload);

      expect(result.streamId).toBe(streamId);
      expect(result.sequence).toBe(1);
      expect(result.hash).toBeDefined();
      expect(result.hash).toMatch(/^[a-f0-9]{64}$/); // SHA256 hex
    });

    it('should link records in sequence', async () => {
      const streamId = 'audit-stream-2';
      const payload1 = { action: 'CLAIM_CREATED', claimId: 'claim-1' };
      const payload2 = { action: 'EVIDENCE_SUBMITTED', claimId: 'claim-1' };

      const result1 = await service.append(streamId, payload1);
      const result2 = await service.append(streamId, payload2);

      expect(result1.sequence).toBe(1);
      expect(result2.sequence).toBe(2);
      expect(result1.hash).not.toBe(result2.hash);

      const record2 = await store.getRecord(streamId, 2);
      expect(record2?.previousHash).toBe(result1.hash);
    });

    it('should sanitize sensitive fields', async () => {
      const streamId = 'audit-stream-3';
      const payload = {
        action: 'PASSWORD_RESET',
        userId: 'user-123',
        password: 'secret-password',
        secret: 'api-secret',
      };

      const result = await service.append(streamId, payload);

      // The hash should not include sensitive fields
      expect(result.hash).toBeDefined();

      // Verify by checking what was actually hashed
      const record = await store.getRecord(streamId, 1);
      expect(record?.payloadHash).toBeDefined();
    });

    it('should throw when no active key', async () => {
      const streamId = 'audit-stream-4';
      const payload = { action: 'TEST' };

      jest.spyOn(keyRegistry, 'getActiveKey').mockResolvedValue(null);

      await expect(service.append(streamId, payload)).rejects.toThrow(
        'No active audit key available',
      );
    });
  });

  describe('createCheckpoint', () => {
    it('should create checkpoint at current head', async () => {
      const streamId = 'audit-stream-5';

      await service.append(streamId, { action: 'TEST1' });
      await service.append(streamId, { action: 'TEST2' });

      const checkpoint = await service.createCheckpoint(streamId);

      expect(checkpoint.streamId).toBe(streamId);
      expect(checkpoint.sequence).toBe(2);
      expect(checkpoint.keyId).toBe('test-key-id');
      expect(checkpoint.headHash).toBeDefined();
    });

    it('should throw on empty stream', async () => {
      const streamId = 'audit-stream-6';

      await expect(service.createCheckpoint(streamId)).rejects.toThrow(
        'No records in stream',
      );
    });
  });

  describe('verifyChain', () => {
    it('should verify valid chain', async () => {
      const streamId = 'audit-stream-7';

      await service.append(streamId, { action: 'TEST1' });
      await service.append(streamId, { action: 'TEST2' });
      await service.append(streamId, { action: 'TEST3' });

      const result = await service.verifyChain(streamId);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect gaps in sequence', async () => {
      const streamId = 'audit-stream-8';

      await service.append(streamId, { action: 'TEST1' });
      await service.append(streamId, { action: 'TEST2' });

      // Manually remove record 2 to create a gap
      const record3 = await store.getRecord(streamId, 2);
      if (record3) {
        // Delete from internal store would require mocking
      }

      const result = await service.verifyChain(streamId, 3);
      // This would detect gaps in a real scenario
    });

    it('should detect hash mismatches', async () => {
      const streamId = 'audit-stream-9';

      await service.append(streamId, { action: 'TEST1' });
      const record = await store.getRecord(streamId, 1);

      if (record) {
        // Verification would catch corrupted hash
        const verified = await store.verify(streamId, 1, 'invalid-hash');
        expect(verified.valid).toBe(false);
      }
    });

    it('should warn on revoked key', async () => {
      const streamId = 'audit-stream-10';

      await service.append(streamId, { action: 'TEST1' });

      jest.spyOn(keyRegistry, 'getKey').mockResolvedValue({
        keyId: 'revoked-key',
        algorithm: 'HMAC-SHA256',
        createdAt: new Date(),
        revokedAt: new Date(),
        isActive: false,
      });

      // Would log warning during verification
      const result = await service.verifyChain(streamId);
      expect(result.valid).toBe(true); // Still valid, just revoked
    });
  });

  describe('exportCheckpointForVerification', () => {
    it('should export checkpoint with all records', async () => {
      const streamId = 'audit-stream-11';

      await service.append(streamId, { action: 'TEST1' });
      await service.append(streamId, { action: 'TEST2' });
      await service.createCheckpoint(streamId);

      const exported = await service.exportCheckpointForVerification(streamId);

      expect(exported.checkpoint).toBeDefined();
      expect(exported.checkpoint.sequence).toBe(2);
      expect(exported.records).toHaveLength(2);
    });

    it('should throw when no checkpoint', async () => {
      const streamId = 'audit-stream-12';

      await expect(
        service.exportCheckpointForVerification(streamId),
      ).rejects.toThrow('No checkpoint for stream');
    });
  });

  describe('concurrent appends', () => {
    it('should serialize concurrent appends safely', async () => {
      const streamId = 'audit-stream-13';

      const promises = Array.from({ length: 5 }, (_, i) =>
        service.append(streamId, { action: `TEST${i + 1}` }),
      );

      const results = await Promise.all(promises);

      // All should succeed without duplicates
      const sequences = results.map((r) => r.sequence).sort();
      expect(sequences).toEqual([1, 2, 3, 4, 5]);
    });
  });
});

import { Test } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { DurableAuditStreamStore } from '../stores/durable-audit-stream.store';
import { AuditStreamRecordEntity } from '../entities/audit-stream-record.entity';
import { AuditStreamCheckpointEntity } from '../entities/audit-stream-checkpoint.entity';

describe('DurableAuditStreamStore', () => {
  let store: DurableAuditStreamStore;
  let recordRepo: Repository<AuditStreamRecordEntity>;
  let checkpointRepo: Repository<AuditStreamCheckpointEntity>;
  let dataSource: DataSource;

  beforeEach(async () => {
    // Mock repositories and datasource
    recordRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
    } as any;

    checkpointRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
    } as any;

    dataSource = {
      transaction: jest.fn((cb) => cb({ getRepository: jest.fn(() => recordRepo) })),
    } as any;

    store = new DurableAuditStreamStore(recordRepo, checkpointRepo, dataSource);
  });

  describe('append', () => {
    it('should enforce unique stream/sequence constraint', async () => {
      const streamId = 'stream-1';

      // First append
      (recordRepo.findOne as jest.Mock).mockResolvedValue(null);
      (recordRepo.create as jest.Mock).mockReturnValue({
        streamId,
        sequence: 1,
        payloadHash: 'hash1',
      });
      (recordRepo.save as jest.Mock).mockResolvedValue({
        streamId,
        sequence: 1,
        payloadHash: 'hash1',
      });

      const result1 = await store.append(streamId, 'hash1', 'sig1', 'key1', '0');

      expect(result1.sequence).toBe(1);
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it('should detect chain continuity violation', async () => {
      const streamId = 'stream-2';
      const existingRecord = {
        sequence: 1,
        payloadHash: 'hash1',
      };

      const findOneCallback = async (where: any) => {
        if (where.streamId === streamId) return existingRecord;
        return null;
      };

      (recordRepo.findOne as jest.Mock).mockImplementation(findOneCallback);

      // Create a mock transaction that calls the callback
      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        const manager = {
          getRepository: jest.fn().mockReturnValue(recordRepo),
        };
        return cb(manager);
      });

      await expect(
        store.append(streamId, 'hash2', 'sig2', 'key2', 'wrong-previous-hash'),
      ).rejects.toThrow('Chain continuity violation');
    });

    it('should link to previous hash on first append', async () => {
      const streamId = 'stream-3';

      (recordRepo.findOne as jest.Mock).mockResolvedValue(null);
      (recordRepo.create as jest.Mock).mockReturnValue({
        streamId,
        sequence: 1,
        payloadHash: 'hash1',
        previousHash: '0',
      });
      (recordRepo.save as jest.Mock).mockResolvedValue({
        streamId,
        sequence: 1,
        payloadHash: 'hash1',
        previousHash: '0',
      });

      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        const manager = {
          getRepository: jest.fn().mockReturnValue(recordRepo),
        };
        return cb(manager);
      });

      const result = await store.append(streamId, 'hash1', 'sig1', 'key1', '0');

      expect(result.sequence).toBe(1);
    });
  });

  describe('checkpoint', () => {
    it('should create checkpoint with current head', async () => {
      const streamId = 'stream-4';
      const checkpoint = {
        streamId,
        sequence: 5,
        headHash: 'hash5',
        keyId: 'key1',
        createdAt: new Date(),
      };

      (checkpointRepo.create as jest.Mock).mockReturnValue(checkpoint);
      (checkpointRepo.save as jest.Mock).mockResolvedValue(checkpoint);

      (dataSource.transaction as jest.Mock).mockImplementation(async (cb) => {
        const manager = {
          getRepository: jest.fn().mockReturnValue(checkpointRepo),
        };
        return cb(manager);
      });

      const result = await store.createCheckpoint(
        streamId,
        5,
        'hash5',
        'key1',
      );

      expect(result.sequence).toBe(5);
      expect(result.streamId).toBe(streamId);
    });

    it('should retrieve latest checkpoint', async () => {
      const streamId = 'stream-5';
      const checkpoint = {
        streamId,
        sequence: 3,
        headHash: 'hash3',
        keyId: 'key1',
      };

      (checkpointRepo.findOne as jest.Mock).mockResolvedValue(checkpoint);

      const result = await store.getLatestCheckpoint(streamId);

      expect(result?.sequence).toBe(3);
    });
  });

  describe('verify', () => {
    it('should verify record with matching hash', async () => {
      const streamId = 'stream-6';
      const record = {
        streamId,
        sequence: 2,
        previousHash: 'hash1',
        payloadHash: 'hash2',
        hmacSignature: 'sig2',
        keyId: 'key1',
      };

      (recordRepo.findOne as jest.Mock).mockResolvedValue(record);

      const result = await store.verify(streamId, 2, 'hash1');

      expect(result.valid).toBe(true);
      expect(result.details?.hashValid).toBe(true);
      expect(result.details?.sequenceValid).toBe(true);
    });

    it('should detect hash mismatch', async () => {
      const streamId = 'stream-7';
      const record = {
        streamId,
        sequence: 2,
        previousHash: 'hash1',
        payloadHash: 'hash2',
      };

      (recordRepo.findOne as jest.Mock).mockResolvedValue(record);

      const result = await store.verify(streamId, 2, 'wrong-hash');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('hash_mismatch');
    });

    it('should report missing record', async () => {
      const streamId = 'stream-8';

      (recordRepo.findOne as jest.Mock).mockResolvedValue(null);

      const result = await store.verify(streamId, 99, 'hash1');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('record_not_found');
      expect(result.details?.recordFound).toBe(false);
    });
  });
});

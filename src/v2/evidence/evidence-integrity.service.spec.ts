import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { EvidenceIntegrityService } from './evidence-integrity.service';
import {
  ProjectEvidence,
  EvidenceStatus,
} from './entities/project-evidence.entity';
import { ProjectEvidenceVersion } from './entities/project-evidence-version.entity';

describe('EvidenceIntegrityService', () => {
  let service: EvidenceIntegrityService;
  let dataSource: jest.Mocked<DataSource>;
  let evidenceRepo: jest.Mocked<Repository<ProjectEvidence>>;
  let versionRepo: jest.Mocked<Repository<ProjectEvidenceVersion>>;

  beforeEach(async () => {
    evidenceRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      count: jest.fn(),
    } as any;

    versionRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      count: jest.fn(),
    } as any;

    dataSource = {
      getRepository: jest.fn((entity) => {
        if (entity === ProjectEvidence) return evidenceRepo;
        if (entity === ProjectEvidenceVersion) return versionRepo;
        throw new Error(`Unexpected entity: ${entity}`);
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EvidenceIntegrityService,
        { provide: getDataSourceToken(), useValue: dataSource },
      ],
    }).compile();

    service = module.get<EvidenceIntegrityService>(EvidenceIntegrityService);
  });

  describe('computeVersionHash', () => {
    it('should compute deterministic hash for version', () => {
      const version: any = {
        evidenceId: '0x123',
        version: 1,
        contentDigest: '0xabc',
        safeMetadataUri: 'ipfs://test',
        submittedBy: '0xactor',
        eventTxHash: '0xtx',
        eventLogIndex: 5,
        blockNumber: '100',
        previousVersionHash: null,
      };

      const hash1 = service.computeVersionHash(version);
      const hash2 = service.computeVersionHash(version);

      expect(hash1).toBe(hash2); // Deterministic
      expect(hash1).toHaveLength(64); // SHA-256 hex
      expect(hash1).toMatch(/^[0-9a-f]{64}$/); // Valid hex
    });

    it('should produce different hashes for different content', () => {
      const version1: any = {
        evidenceId: '0x123',
        version: 1,
        contentDigest: '0xabc',
        safeMetadataUri: null,
        submittedBy: null,
        eventTxHash: '0xtx',
        eventLogIndex: 5,
        blockNumber: '100',
        previousVersionHash: null,
      };

      const version2: any = {
        ...version1,
        contentDigest: '0xdef', // Different digest
      };

      const hash1 = service.computeVersionHash(version1);
      const hash2 = service.computeVersionHash(version2);

      expect(hash1).not.toBe(hash2);
    });

    it('should handle null fields in hash computation', () => {
      const version: any = {
        evidenceId: '0x123',
        version: 1,
        contentDigest: '0xabc',
        safeMetadataUri: null,
        submittedBy: null,
        eventTxHash: '0xtx',
        eventLogIndex: 5,
        blockNumber: '100',
        previousVersionHash: null,
      };

      const hash = service.computeVersionHash(version);
      expect(hash).toBeDefined();
      expect(hash).toHaveLength(64);
    });

    it('should normalize bigint blockNumber to string', () => {
      const version1: any = {
        evidenceId: '0x123',
        version: 1,
        contentDigest: '0xabc',
        safeMetadataUri: null,
        submittedBy: null,
        eventTxHash: '0xtx',
        eventLogIndex: 5,
        blockNumber: '100', // String
        previousVersionHash: null,
      };

      const version2: any = {
        ...version1,
        blockNumber: 100, // Number (will be stringified)
      };

      const hash1 = service.computeVersionHash(version1);
      const hash2 = service.computeVersionHash(version2);

      expect(hash1).toBe(hash2); // Should normalize to same value
    });

    it('should include previousVersionHash in computation', () => {
      const version1: any = {
        evidenceId: '0x123',
        version: 2,
        contentDigest: '0xabc',
        safeMetadataUri: null,
        submittedBy: null,
        eventTxHash: '0xtx',
        eventLogIndex: 5,
        blockNumber: '100',
        previousVersionHash: null,
      };

      const version2: any = {
        ...version1,
        previousVersionHash: '0xprevhash',
      };

      const hash1 = service.computeVersionHash(version1);
      const hash2 = service.computeVersionHash(version2);

      expect(hash1).not.toBe(hash2); // Different due to previousVersionHash
    });
  });

  describe('computeEvidenceHash', () => {
    it('should compute deterministic hash for evidence', () => {
      const evidence: any = {
        evidenceId: '0x123',
        claimId: '0xclaim',
        currentVersion: 2,
        status: EvidenceStatus.ACTIVE,
        contentDigest: '0xabc',
        lastEventBlockNumber: '100',
        lastEventLogIndex: 5,
      };

      const hash1 = service.computeEvidenceHash(evidence);
      const hash2 = service.computeEvidenceHash(evidence);

      expect(hash1).toBe(hash2); // Deterministic
      expect(hash1).toHaveLength(64);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce different hashes for different status', () => {
      const evidence1: any = {
        evidenceId: '0x123',
        claimId: '0xclaim',
        currentVersion: 2,
        status: EvidenceStatus.ACTIVE,
        contentDigest: '0xabc',
        lastEventBlockNumber: '100',
        lastEventLogIndex: 5,
      };

      const evidence2: any = {
        ...evidence1,
        status: EvidenceStatus.REMOVED,
      };

      const hash1 = service.computeEvidenceHash(evidence1);
      const hash2 = service.computeEvidenceHash(evidence2);

      expect(hash1).not.toBe(hash2);
    });

    it('should exclude timestamps from hash computation', () => {
      const evidence: any = {
        evidenceId: '0x123',
        claimId: '0xclaim',
        currentVersion: 2,
        status: EvidenceStatus.ACTIVE,
        contentDigest: '0xabc',
        lastEventBlockNumber: '100',
        lastEventLogIndex: 5,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-02'),
      };

      const hash1 = service.computeEvidenceHash(evidence);

      // Change timestamps (should not affect hash)
      evidence.createdAt = new Date('2024-02-01');
      evidence.updatedAt = new Date('2024-02-02');

      const hash2 = service.computeEvidenceHash(evidence);

      expect(hash1).toBe(hash2); // Timestamps excluded
    });
  });

  describe('verifyVersionIntegrity', () => {
    it('should verify valid integrity hash', async () => {
      const version: any = {
        evidenceId: '0x123',
        version: 1,
        contentDigest: '0xabc',
        safeMetadataUri: null,
        submittedBy: null,
        eventTxHash: '0xtx',
        eventLogIndex: 5,
        blockNumber: '100',
        previousVersionHash: null,
        integrityHash: null,
      };

      // Compute expected hash
      version.integrityHash = service.computeVersionHash(version);

      versionRepo.findOne.mockResolvedValue(version);

      const result = await service.verifyVersionIntegrity('0x123', 1);

      expect(result.valid).toBe(true);
      expect(result.entityId).toBe('0x123:v1');
      expect(result.entityType).toBe('version');
      expect(result.integrityHash).toBe(version.integrityHash);
      expect(result.reason).toBeUndefined();
    });

    it('should detect hash mismatch', async () => {
      const version: any = {
        evidenceId: '0x123',
        version: 1,
        contentDigest: '0xabc',
        safeMetadataUri: null,
        submittedBy: null,
        eventTxHash: '0xtx',
        eventLogIndex: 5,
        blockNumber: '100',
        previousVersionHash: null,
        integrityHash: 'invalid_hash_1234567890'.padEnd(64, '0'),
      };

      versionRepo.findOne.mockResolvedValue(version);

      const result = await service.verifyVersionIntegrity('0x123', 1);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('hash_mismatch');
      expect(result.details).toContain('Expected');
      expect(result.expectedHash).toBeDefined();
    });

    it('should detect missing hash', async () => {
      const version: any = {
        evidenceId: '0x123',
        version: 1,
        contentDigest: '0xabc',
        safeMetadataUri: null,
        submittedBy: null,
        eventTxHash: '0xtx',
        eventLogIndex: 5,
        blockNumber: '100',
        previousVersionHash: null,
        integrityHash: null,
      };

      versionRepo.findOne.mockResolvedValue(version);

      const result = await service.verifyVersionIntegrity('0x123', 1);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('hash_missing');
      expect(result.details).toContain('not been stamped');
    });

    it('should handle not found version', async () => {
      versionRepo.findOne.mockResolvedValue(null);

      const result = await service.verifyVersionIntegrity('0x123', 999);

      expect(result.valid).toBe(false);
      expect(result.entityId).toBe('0x123:v999');
      expect(result.reason).toBe('not_found');
    });
  });

  describe('verifyEvidenceIntegrity', () => {
    it('should verify valid integrity hash', async () => {
      const evidence: any = {
        evidenceId: '0x123',
        claimId: '0xclaim',
        currentVersion: 1,
        status: EvidenceStatus.ACTIVE,
        contentDigest: '0xabc',
        lastEventBlockNumber: '100',
        lastEventLogIndex: 5,
        integrityHash: null,
      };

      evidence.integrityHash = service.computeEvidenceHash(evidence);

      evidenceRepo.findOne.mockResolvedValue(evidence);

      const result = await service.verifyEvidenceIntegrity('0x123');

      expect(result.valid).toBe(true);
      expect(result.entityId).toBe('0x123');
      expect(result.entityType).toBe('evidence');
    });

    it('should detect hash mismatch', async () => {
      const evidence: any = {
        evidenceId: '0x123',
        claimId: '0xclaim',
        currentVersion: 1,
        status: EvidenceStatus.ACTIVE,
        contentDigest: '0xabc',
        lastEventBlockNumber: '100',
        lastEventLogIndex: 5,
        integrityHash: 'wrong_hash'.padEnd(64, '0'),
      };

      evidenceRepo.findOne.mockResolvedValue(evidence);

      const result = await service.verifyEvidenceIntegrity('0x123');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('hash_mismatch');
    });

    it('should handle not found evidence', async () => {
      evidenceRepo.findOne.mockResolvedValue(null);

      const result = await service.verifyEvidenceIntegrity('0xnonexistent');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('not_found');
    });
  });

  describe('verifyChainOfCustody', () => {
    it('should validate valid chain', async () => {
      const version1: any = {
        evidenceId: '0x123',
        version: 1,
        integrityHash: 'hash1'.padEnd(64, '0'),
        previousVersionHash: null,
      };

      const version2: any = {
        evidenceId: '0x123',
        version: 2,
        integrityHash: 'hash2'.padEnd(64, '0'),
        previousVersionHash: 'hash1'.padEnd(64, '0'),
      };

      versionRepo.find.mockResolvedValue([version1, version2]);

      const result = await service.verifyChainOfCustody('0x123');

      expect(result.valid).toBe(true);
      expect(result.totalVersions).toBe(2);
      expect(result.brokenAt).toBeUndefined();
    });

    it('should detect broken chain', async () => {
      const version1: any = {
        evidenceId: '0x123',
        version: 1,
        integrityHash: 'hash1'.padEnd(64, '0'),
        previousVersionHash: null,
      };

      const version2: any = {
        evidenceId: '0x123',
        version: 2,
        integrityHash: 'hash2'.padEnd(64, '0'),
        previousVersionHash: 'wrong_hash'.padEnd(64, '0'), // Mismatch
      };

      versionRepo.find.mockResolvedValue([version1, version2]);

      const result = await service.verifyChainOfCustody('0x123');

      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(2);
      expect(result.reason).toContain('Chain break');
    });

    it('should detect version gap', async () => {
      const version1: any = {
        evidenceId: '0x123',
        version: 1,
        integrityHash: 'hash1'.padEnd(64, '0'),
        previousVersionHash: null,
      };

      const version3: any = {
        evidenceId: '0x123',
        version: 3, // Skipped version 2
        integrityHash: 'hash3'.padEnd(64, '0'),
        previousVersionHash: 'hash1'.padEnd(64, '0'),
      };

      versionRepo.find.mockResolvedValue([version1, version3]);

      const result = await service.verifyChainOfCustody('0x123');

      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(3);
      expect(result.reason).toContain('Version gap');
    });

    it('should reject version 1 with non-null previousVersionHash', async () => {
      const version1: any = {
        evidenceId: '0x123',
        version: 1,
        integrityHash: 'hash1'.padEnd(64, '0'),
        previousVersionHash: 'should_be_null'.padEnd(64, '0'),
      };

      versionRepo.find.mockResolvedValue([version1]);

      const result = await service.verifyChainOfCustody('0x123');

      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(1);
      expect(result.reason).toContain('non-null previousVersionHash');
    });

    it('should handle no versions found', async () => {
      versionRepo.find.mockResolvedValue([]);

      const result = await service.verifyChainOfCustody('0x123');

      expect(result.valid).toBe(false);
      expect(result.totalVersions).toBe(0);
      expect(result.reason).toContain('No versions found');
    });

    it('should reject first version not being 1', async () => {
      const version2: any = {
        evidenceId: '0x123',
        version: 2, // Should start at 1
        integrityHash: 'hash2'.padEnd(64, '0'),
        previousVersionHash: null,
      };

      versionRepo.find.mockResolvedValue([version2]);

      const result = await service.verifyChainOfCustody('0x123');

      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(2);
      expect(result.reason).toContain('expected 1');
    });
  });

  describe('getPreviousVersionHash', () => {
    it('should return null for version < 1', async () => {
      const result = await service.getPreviousVersionHash('0x123', 0);
      expect(result).toBeNull();
    });

    it('should return integrity hash of previous version', async () => {
      const version: any = {
        integrityHash: 'previous_hash'.padEnd(64, '0'),
      };

      versionRepo.findOne.mockResolvedValue(version);

      const result = await service.getPreviousVersionHash('0x123', 1);

      expect(result).toBe('previous_hash'.padEnd(64, '0'));
      expect(versionRepo.findOne).toHaveBeenCalledWith({
        where: { evidenceId: '0x123', version: 1 },
        select: ['integrityHash'],
      });
    });

    it('should return null if version not found', async () => {
      versionRepo.findOne.mockResolvedValue(null);

      const result = await service.getPreviousVersionHash('0x123', 5);

      expect(result).toBeNull();
    });

    it('should return null if version has no hash', async () => {
      versionRepo.findOne.mockResolvedValue({ integrityHash: null } as any);

      const result = await service.getPreviousVersionHash('0x123', 1);

      expect(result).toBeNull();
    });
  });

  describe('getIntegrityStatistics', () => {
    it('should return correct statistics', async () => {
      evidenceRepo.count.mockResolvedValueOnce(100); // totalEvidence
      evidenceRepo.count.mockResolvedValueOnce(5); // evidenceUnstamped
      versionRepo.count.mockResolvedValueOnce(250); // totalVersions
      versionRepo.count.mockResolvedValueOnce(10); // versionsUnstamped

      const result = await service.getIntegrityStatistics();

      expect(result).toEqual({
        totalEvidence: 100,
        totalVersions: 250,
        evidenceStamped: 95,
        versionsStamped: 240,
        evidenceUnstamped: 5,
        versionsUnstamped: 10,
      });
    });

    it('should handle zero records', async () => {
      evidenceRepo.count.mockResolvedValue(0);
      versionRepo.count.mockResolvedValue(0);

      const result = await service.getIntegrityStatistics();

      expect(result).toEqual({
        totalEvidence: 0,
        totalVersions: 0,
        evidenceStamped: 0,
        versionsStamped: 0,
        evidenceUnstamped: 0,
        versionsUnstamped: 0,
      });
    });
  });

  describe('verifyBatch', () => {
    it('should verify multiple evidence items', async () => {
      const evidence1: any = {
        evidenceId: '0x123',
        claimId: '0xclaim1',
        currentVersion: 1,
        status: EvidenceStatus.ACTIVE,
        contentDigest: '0xabc',
        lastEventBlockNumber: '100',
        lastEventLogIndex: 5,
        integrityHash: null,
      };
      evidence1.integrityHash = service.computeEvidenceHash(evidence1);

      const evidence2: any = {
        evidenceId: '0x456',
        claimId: '0xclaim2',
        currentVersion: 1,
        status: EvidenceStatus.ACTIVE,
        contentDigest: '0xdef',
        lastEventBlockNumber: '101',
        lastEventLogIndex: 3,
        integrityHash: 'wrong_hash'.padEnd(64, '0'),
      };

      evidenceRepo.findOne
        .mockResolvedValueOnce(evidence1)
        .mockResolvedValueOnce(evidence2);

      const results = await service.verifyBatch(['0x123', '0x456']);

      expect(results).toHaveLength(2);
      expect(results[0].valid).toBe(true);
      expect(results[0].entityId).toBe('0x123');
      expect(results[1].valid).toBe(false);
      expect(results[1].entityId).toBe('0x456');
      expect(results[1].reason).toBe('hash_mismatch');
    });
  });
});

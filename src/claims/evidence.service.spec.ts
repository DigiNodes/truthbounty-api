import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { EvidenceService } from './evidence.service';
import { Evidence } from './entities/evidence.entity';
import { EvidenceVersion } from './entities/evidence-version.entity';
import { AuditTrailService } from '../audit/services/audit-trail.service';

describe('EvidenceService', () => {
  let service: EvidenceService;
  let evidenceRepo: Repository<Evidence>;
  let evidenceVersionRepo: Repository<EvidenceVersion>;
  let auditTrailService: AuditTrailService;
const makeEvidence = (overrides: Partial<Evidence> = {}): Evidence =>
  ({
    id: 'ev-1',
    claimId: 'claim-1',
    latestVersion: 1,
    createdAt: new Date(),
    versions: [],
    ...overrides,
  }) as Evidence;

const makeVersion = (overrides: Partial<EvidenceVersion> = {}): EvidenceVersion =>
  ({
    id: 'ver-1',
    evidenceId: 'ev-1',
    version: 1,
    cid: 'cid-abc',
    hash: null,
    submittedBy: null,
    createdAt: new Date(),
    ...overrides,
  }) as EvidenceVersion;

describe('EvidenceService', () => {
  let service: EvidenceService;
  let evidenceRepo: jest.Mocked<Repository<Evidence>>;
  let versionRepo: jest.Mocked<Repository<EvidenceVersion>>;
  let auditTrailService: { log: jest.Mock };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EvidenceService,
        {
          provide: getRepositoryToken(Evidence),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(EvidenceVersion),
          useClass: Repository,
        },
        {
          provide: AuditTrailService,
          useValue: {
            log: jest.fn(),
          },
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            findOneBy: jest.fn(),
            find: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(EvidenceVersion),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
          },
        },
        {
          provide: AuditTrailService,
          useValue: { log: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<EvidenceService>(EvidenceService);
    evidenceRepo = module.get<Repository<Evidence>>(getRepositoryToken(Evidence));
    evidenceVersionRepo = module.get<Repository<EvidenceVersion>>(getRepositoryToken(EvidenceVersion));
    auditTrailService = module.get<AuditTrailService>(AuditTrailService);
    service = module.get(EvidenceService);
    evidenceRepo = module.get(getRepositoryToken(Evidence));
    versionRepo = module.get(getRepositoryToken(EvidenceVersion));
    auditTrailService = module.get(AuditTrailService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getEvidence', () => {
    it('should return evidence if not hidden', async () => {
      const evidence = { id: 'ev-1', isHidden: false } as Evidence;
      jest.spyOn(evidenceRepo, 'findOne').mockResolvedValue(evidence);

      const result = await service.getEvidence('ev-1');

      expect(result).toEqual(evidence);
      expect(evidenceRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ev-1', isHidden: false },
        }),
      );
    });

    it('should return null if hidden and includeHidden is false', async () => {
      jest.spyOn(evidenceRepo, 'findOne').mockResolvedValue(null);

      const result = await service.getEvidence('ev-1');

      expect(result).toBeNull();
      expect(evidenceRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ev-1', isHidden: false },
        }),
      );
    });

    it('should return evidence if hidden and includeHidden is true', async () => {
      const evidence = { id: 'ev-1', isHidden: true } as Evidence;
      jest.spyOn(evidenceRepo, 'findOne').mockResolvedValue(evidence);

      const result = await service.getEvidence('ev-1', true);

      expect(result).toEqual(evidence);
      expect(evidenceRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ev-1' },
        }),
      );
  describe('createEvidence', () => {
    it('creates evidence with version 1', async () => {
      const evidence = makeEvidence();
      const version = makeVersion();

      evidenceRepo.create.mockReturnValue(evidence);
      evidenceRepo.save.mockResolvedValue(evidence);
      versionRepo.create.mockReturnValue(version);
      versionRepo.save.mockResolvedValue(version);

      const result = await service.createEvidence('claim-1', 'cid-abc');

      expect(evidenceRepo.create).toHaveBeenCalledWith({ claimId: 'claim-1', latestVersion: 1 });
      expect(versionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ evidenceId: 'ev-1', version: 1, cid: 'cid-abc' }),
      );
      expect(result).toEqual(evidence);
    });

    it('persists hash and submittedBy on first version', async () => {
      const evidence = makeEvidence();
      const version = makeVersion({ hash: 'sha256-abc', submittedBy: 'user-1' });

      evidenceRepo.create.mockReturnValue(evidence);
      evidenceRepo.save.mockResolvedValue(evidence);
      versionRepo.create.mockReturnValue(version);
      versionRepo.save.mockResolvedValue(version);

      await service.createEvidence('claim-1', 'cid-abc', 'user-1', 'sha256-abc');

      expect(versionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ hash: 'sha256-abc', submittedBy: 'user-1' }),
      );
    });

    it('logs audit trail on creation', async () => {
      const evidence = makeEvidence();
      const version = makeVersion();

      evidenceRepo.create.mockReturnValue(evidence);
      evidenceRepo.save.mockResolvedValue(evidence);
      versionRepo.create.mockReturnValue(version);
      versionRepo.save.mockResolvedValue(version);

      await service.createEvidence('claim-1', 'cid-abc', 'user-1');

      expect(auditTrailService.log).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
      );
    });
  });

  describe('addEvidenceVersion', () => {
    it('increments latestVersion and saves new version', async () => {
      const evidence = makeEvidence({ latestVersion: 1 });
      const newVersion = makeVersion({ version: 2, cid: 'cid-v2' });

      evidenceRepo.findOneBy.mockResolvedValue(evidence);
      evidenceRepo.save.mockResolvedValue({ ...evidence, latestVersion: 2 });
      versionRepo.create.mockReturnValue(newVersion);
      versionRepo.save.mockResolvedValue(newVersion);

      const result = await service.addEvidenceVersion('ev-1', 'cid-v2');

      expect(evidenceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ latestVersion: 2 }),
      );
      expect(versionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ version: 2, cid: 'cid-v2' }),
      );
      expect(result).toEqual(newVersion);
    });

    it('persists hash and submittedBy on new version', async () => {
      const evidence = makeEvidence({ latestVersion: 2 });
      const newVersion = makeVersion({ version: 3, hash: 'sha256-xyz', submittedBy: 'user-2' });

      evidenceRepo.findOneBy.mockResolvedValue(evidence);
      evidenceRepo.save.mockResolvedValue({ ...evidence, latestVersion: 3 });
      versionRepo.create.mockReturnValue(newVersion);
      versionRepo.save.mockResolvedValue(newVersion);

      await service.addEvidenceVersion('ev-1', 'cid-v3', 'user-2', 'sha256-xyz');

      expect(versionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ hash: 'sha256-xyz', submittedBy: 'user-2' }),
      );
    });

    it('throws NotFoundException when evidence does not exist', async () => {
      evidenceRepo.findOneBy.mockResolvedValue(null);

      await expect(service.addEvidenceVersion('missing', 'cid')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('logs audit trail on version update', async () => {
      const evidence = makeEvidence({ latestVersion: 1 });
      const newVersion = makeVersion({ version: 2 });

      evidenceRepo.findOneBy.mockResolvedValue(evidence);
      evidenceRepo.save.mockResolvedValue({ ...evidence, latestVersion: 2 });
      versionRepo.create.mockReturnValue(newVersion);
      versionRepo.save.mockResolvedValue(newVersion);

      await service.addEvidenceVersion('ev-1', 'cid-v2', 'user-1');

      expect(auditTrailService.log).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
      );
    });
  });

  describe('getEvidence', () => {
    it('returns evidence with versions', async () => {
      const evidence = makeEvidence({ versions: [makeVersion()] });
      evidenceRepo.findOne.mockResolvedValue(evidence);

      const result = await service.getEvidence('ev-1');

      expect(evidenceRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'ev-1' }, relations: ['versions'] }),
      );
      expect(result).toEqual(evidence);
    });

    it('returns null when evidence not found', async () => {
      evidenceRepo.findOne.mockResolvedValue(null);
      expect(await service.getEvidence('missing')).toBeNull();
    });
  });

  describe('getLatestEvidenceVersion', () => {
    it('returns the version matching latestVersion', async () => {
      const evidence = makeEvidence({ latestVersion: 2 });
      const version = makeVersion({ version: 2 });

      evidenceRepo.findOneBy.mockResolvedValue(evidence);
      versionRepo.findOne.mockResolvedValue(version);

      const result = await service.getLatestEvidenceVersion('ev-1');

      expect(versionRepo.findOne).toHaveBeenCalledWith({
        where: { evidenceId: 'ev-1', version: 2 },
      });
      expect(result).toEqual(version);
    });

    it('returns null when evidence not found', async () => {
      evidenceRepo.findOneBy.mockResolvedValue(null);
      expect(await service.getLatestEvidenceVersion('missing')).toBeNull();
    });
  });

  describe('getEvidenceForClaim', () => {
    it('should filter out hidden evidence by default', async () => {
      const claimId = 'claim-1';
      const evidences = [{ id: 'ev-1', isHidden: false }] as Evidence[];
      jest.spyOn(evidenceRepo, 'find').mockResolvedValue(evidences);

      const result = await service.getEvidenceForClaim(claimId);

      expect(result).toEqual(evidences);
      expect(evidenceRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { claimId, isHidden: false },
        }),
      );
    });

    it('should include hidden evidence if includeHidden is true', async () => {
      const claimId = 'claim-1';
      const evidences = [
        { id: 'ev-1', isHidden: false },
        { id: 'ev-2', isHidden: true },
      ] as Evidence[];
      jest.spyOn(evidenceRepo, 'find').mockResolvedValue(evidences);

      const result = await service.getEvidenceForClaim(claimId, true);

      expect(result).toEqual(evidences);
      expect(evidenceRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { claimId },
        }),
      );
    it('returns all evidence for a claim', async () => {
      const evidences = [makeEvidence()];
      evidenceRepo.find.mockResolvedValue(evidences);

      const result = await service.getEvidenceForClaim('claim-1');

      expect(evidenceRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { claimId: 'claim-1' } }),
      );
      expect(result).toEqual(evidences);
    });
  });

  describe('getLatestEvidenceForClaim', () => {
    it('returns latest version of first evidence for a claim', async () => {
      const evidence = makeEvidence({ latestVersion: 1 });
      const version = makeVersion();

      evidenceRepo.find.mockResolvedValue([evidence]);
      versionRepo.findOne.mockResolvedValue(version);

      const result = await service.getLatestEvidenceForClaim('claim-1');

      expect(versionRepo.findOne).toHaveBeenCalledWith({
        where: { evidenceId: 'ev-1', version: 1 },
      });
      expect(result).toEqual(version);
    });

    it('returns null when no evidence exists for claim', async () => {
      evidenceRepo.find.mockResolvedValue([]);
      expect(await service.getLatestEvidenceForClaim('claim-1')).toBeNull();
    });
  });

  describe('verifyEvidence', () => {
    it('returns evidence and logs audit trail', async () => {
      const evidence = makeEvidence();
      evidenceRepo.findOneBy.mockResolvedValue(evidence);

      const result = await service.verifyEvidence('ev-1', 'user-1');

      expect(auditTrailService.log).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
      );
      expect(result).toEqual(evidence);
    });

    it('throws NotFoundException when evidence does not exist', async () => {
      evidenceRepo.findOneBy.mockResolvedValue(null);

      await expect(service.verifyEvidence('missing')).rejects.toThrow(NotFoundException);
    });
  });
});

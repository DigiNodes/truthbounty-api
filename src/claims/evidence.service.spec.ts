/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { EvidenceService, EvidenceAvailability } from './evidence.service';
import { Evidence } from './entities/evidence.entity';
import { EvidenceVersion } from './entities/evidence-version.entity';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import { IpfsService } from '../ipfs/ipfs.service';
import { CID } from 'multiformats/cid';

type EvidenceRepoMock = jest.Mocked<
  Pick<
    Repository<Evidence>,
    'create' | 'save' | 'findOneBy' | 'findOne' | 'find' | 'findAndCount'
  >
>;

type EvidenceVersionRepoMock = jest.Mocked<
  Pick<
    Repository<EvidenceVersion>,
    'create' | 'save' | 'findOneBy' | 'find' | 'findAndCount'
  >
>;

const repositoryMock = () =>
  ({
    create: jest.fn(),
    save: jest.fn(),
    findOneBy: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    findAndCount: jest.fn(),
  }) as unknown as EvidenceRepoMock & EvidenceVersionRepoMock;

const cidParse = CID.parse as unknown as jest.Mock;

const makeEvidence = (overrides: Partial<Evidence> = {}): Evidence =>
  ({
    id: 'ev-1',
    claimId: 'claim-1',
    latestVersion: 1,
    isHidden: false,
    onChainRegistered: false,
    blockNumber: null,
    transactionHash: null,
    createdAt: new Date(),
    versions: [],
    ...overrides,
  }) as Evidence;

const makeVersion = (
  overrides: Partial<EvidenceVersion> = {},
): EvidenceVersion =>
  ({
    id: 'ver-1',
    evidenceId: 'ev-1',
    version: 1,
    cid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    hash: null,
    submittedBy: null,
    createdAt: new Date(),
    ...overrides,
  }) as EvidenceVersion;

describe('EvidenceService', () => {
  let service: EvidenceService;
  let evidenceRepo: EvidenceRepoMock;
  let versionRepo: EvidenceVersionRepoMock;
  let auditTrailService: { log: jest.Mock };
  let ipfsService: { getGatewayUrl: jest.Mock };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EvidenceService,
        {
          provide: getRepositoryToken(Evidence),
          useValue: repositoryMock(),
        },
        {
          provide: getRepositoryToken(EvidenceVersion),
          useValue: repositoryMock(),
        },
        {
          provide: AuditTrailService,
          useValue: { log: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: IpfsService,
          useValue: {
            getGatewayUrl: jest.fn(),
            uploadBuffer: jest.fn(),
            uploadStream: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<EvidenceService>(EvidenceService);
    evidenceRepo = module.get<EvidenceRepoMock>(getRepositoryToken(Evidence));
    versionRepo = module.get<EvidenceVersionRepoMock>(
      getRepositoryToken(EvidenceVersion),
    );
    auditTrailService = module.get<{ log: jest.Mock }>(AuditTrailService);
    ipfsService = module.get<IpfsService>(IpfsService) as unknown as {
      getGatewayUrl: jest.Mock;
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
    cidParse.mockReset();
  });

  describe('createEvidence', () => {
    it('creates evidence with an initial version and audits', async () => {
      const savedEvidence = makeEvidence({ id: 'ev-new' });
      const savedVersion = makeVersion({ evidenceId: 'ev-new' });

      evidenceRepo.create.mockReturnValue(makeEvidence());
      evidenceRepo.save.mockResolvedValueOnce(savedEvidence);
      versionRepo.create.mockReturnValue(savedVersion);
      versionRepo.save.mockResolvedValue(savedVersion);

      const result = await service.createEvidence('claim-1', 'QmCid', 'u1');

      expect(versionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          evidenceId: 'ev-new',
          version: 1,
          cid: 'QmCid',
          submittedBy: 'u1',
        }),
      );
      expect(auditTrailService.log).toHaveBeenCalledTimes(1);
      expect(result.id).toBe('ev-new');
    });
  });

  describe('addEvidenceVersion', () => {
    it('increments the latest version and audits', async () => {
      const existing = makeEvidence({ latestVersion: 1 });
      evidenceRepo.findOneBy.mockResolvedValue(existing);
      versionRepo.create.mockImplementation((v) => v as EvidenceVersion);
      versionRepo.save.mockResolvedValue(makeVersion({ version: 2 }));
      evidenceRepo.save.mockResolvedValue(makeEvidence({ latestVersion: 2 }));

      const result = await service.addEvidenceVersion('ev-1', 'QmCid2', 'u1');

      expect(versionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          evidenceId: 'ev-1',
          version: 2,
          cid: 'QmCid2',
        }),
      );
      expect(evidenceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ latestVersion: 2 }),
      );
      expect(auditTrailService.log).toHaveBeenCalledTimes(1);
      expect(result.version).toBe(2);
    });

    it('throws NotFoundException when evidence is missing', async () => {
      evidenceRepo.findOneBy.mockResolvedValue(null);
      await expect(service.addEvidenceVersion('nope', 'QmCid')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getEvidence / getEvidenceOrFail', () => {
    it('returns the evidence with versions', async () => {
      const ev = makeEvidence({ versions: [makeVersion()] });
      evidenceRepo.findOne.mockResolvedValue(ev);
      await expect(service.getEvidence('ev-1')).resolves.toBe(ev);
    });

    it('getEvidenceOrFail throws when missing', async () => {
      evidenceRepo.findOne.mockResolvedValue(null);
      await expect(service.getEvidenceOrFail('nope')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listEvidence', () => {
    it('applies bounded pagination and deterministic ordering', async () => {
      const rows = [makeEvidence({ id: 'ev-2' }), makeEvidence({ id: 'ev-1' })];
      evidenceRepo.findAndCount.mockResolvedValue([rows, 2]);

      const result = await service.listEvidence({ page: 1, limit: 20 });

      expect(evidenceRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 20,
          order: { createdAt: 'ASC', id: 'ASC' },
        }),
      );
      expect(result.meta).toEqual({
        total: 2,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
      expect(result.data.length).toBe(2);
    });

    it('computes totalPages across multiple pages', async () => {
      evidenceRepo.findAndCount.mockResolvedValue([[makeEvidence()], 25]);
      const result = await service.listEvidence({ page: 2, limit: 10 });
      expect(result.meta).toEqual({
        total: 25,
        page: 2,
        limit: 10,
        totalPages: 3,
      });
    });

    it('filters by claimId when provided', async () => {
      evidenceRepo.findAndCount.mockResolvedValue([[makeEvidence()], 1]);
      await service.listEvidence({ page: 1, limit: 20, claimId: 'claim-9' });
      expect(evidenceRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { claimId: 'claim-9' } }),
      );
    });

    it('returns zero totalPages for empty result', async () => {
      evidenceRepo.findAndCount.mockResolvedValue([[], 0]);
      const result = await service.listEvidence({ page: 1, limit: 20 });
      expect(result.meta.totalPages).toBe(0);
    });
  });

  describe('listEvidenceVersions', () => {
    it('throws when evidence is missing', async () => {
      evidenceRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.listEvidenceVersions('nope', { page: 1, limit: 20 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('orders versions newest-first with pagination', async () => {
      evidenceRepo.findOneBy.mockResolvedValue(makeEvidence());
      versionRepo.findAndCount.mockResolvedValue([
        [makeVersion({ version: 3 }), makeVersion({ version: 2 })],
        3,
      ]);
      const result = await service.listEvidenceVersions('ev-1', {
        page: 1,
        limit: 2,
      });
      expect(versionRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { evidenceId: 'ev-1' },
          order: { version: 'DESC' },
          skip: 0,
          take: 2,
        }),
      );
      expect(result.meta).toEqual({
        total: 3,
        page: 1,
        limit: 2,
        totalPages: 2,
      });
    });
  });

  describe('getContentDigest', () => {
    it('returns the CID-encoded digest', async () => {
      evidenceRepo.findOneBy.mockResolvedValue(makeEvidence());
      versionRepo.findOneBy.mockResolvedValue(makeVersion());
      cidParse.mockReturnValue({
        version: 1,
        code: 0x55,
        multihash: { code: 0x12, digest: new Uint8Array([1, 2, 3]) },
      });

      const digest = await service.getContentDigest('ev-1');
      expect(digest.digestHex).toBe('010203');
      expect(digest.codecCode).toBe(0x55);
      expect(digest.hashCode).toBe(0x12);
    });

    it('throws BadRequestException when the stored CID is invalid', async () => {
      evidenceRepo.findOneBy.mockResolvedValue(makeEvidence());
      versionRepo.findOneBy.mockResolvedValue(makeVersion());
      cidParse.mockImplementation(() => {
        throw new Error('invalid');
      });
      await expect(service.getContentDigest('ev-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFoundException for unknown version', async () => {
      evidenceRepo.findOneBy
        .mockResolvedValueOnce(makeEvidence())
        .mockResolvedValueOnce(null);
      await expect(service.getContentDigest('ev-1', 99)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getSafeGateway', () => {
    it('returns the sanitized gateway url', async () => {
      evidenceRepo.findOneBy.mockResolvedValue(makeEvidence());
      versionRepo.findOneBy.mockResolvedValue(makeVersion());
      ipfsService.getGatewayUrl.mockReturnValue('https://gateway.example/cid');

      const result = await service.getSafeGateway('ev-1');
      expect(result).toEqual({
        cid: makeVersion().cid,
        gatewayUrl: 'https://gateway.example/cid',
      });
    });

    it('returns undefined gateway url when unavailable', async () => {
      evidenceRepo.findOneBy.mockResolvedValue(makeEvidence());
      versionRepo.findOneBy.mockResolvedValue(makeVersion());
      ipfsService.getGatewayUrl.mockReturnValue(undefined);

      const result = await service.getSafeGateway('ev-1');
      expect(result.gatewayUrl).toBeUndefined();
    });
  });

  describe('getAvailabilityStatus', () => {
    it('reports ONCHAIN_NOT_REGISTERED before on-chain registration', async () => {
      evidenceRepo.findOneBy.mockResolvedValue(
        makeEvidence({ onChainRegistered: false }),
      );
      const status = await service.getAvailabilityStatus('ev-1');
      expect(status.availability).toBe(
        EvidenceAvailability.ONCHAIN_NOT_REGISTERED,
      );
      expect(status.onChainRegistered).toBe(false);
    });

    it('reports OFFCHAIN_UNAVAILABLE when registered but no safe gateway', async () => {
      evidenceRepo.findOneBy.mockResolvedValue(
        makeEvidence({ onChainRegistered: true }),
      );
      versionRepo.findOneBy.mockResolvedValue(makeVersion());
      ipfsService.getGatewayUrl.mockReturnValue(undefined);

      const status = await service.getAvailabilityStatus('ev-1');
      expect(status.availability).toBe(
        EvidenceAvailability.OFFCHAIN_UNAVAILABLE,
      );
    });

    it('reports AVAILABLE when registered and content addressable', async () => {
      evidenceRepo.findOneBy.mockResolvedValue(
        makeEvidence({ onChainRegistered: true }),
      );
      versionRepo.findOneBy.mockResolvedValue(makeVersion());
      ipfsService.getGatewayUrl.mockReturnValue('https://gateway.example/c');

      const status = await service.getAvailabilityStatus('ev-1');
      expect(status.availability).toBe(EvidenceAvailability.AVAILABLE);
      expect(status.gatewayUrl).toBe('https://gateway.example/c');
    });

    it('throws NotFound when evidence missing', async () => {
      evidenceRepo.findOneBy.mockResolvedValue(null);
      await expect(service.getAvailabilityStatus('nope')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

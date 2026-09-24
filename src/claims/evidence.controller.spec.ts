import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EvidenceController } from './evidence.controller';
import { EvidenceFlagService } from './evidence-flag.service';
import { EvidenceService, EvidenceAvailability } from './evidence.service';
import { Paginated } from './evidence.service';

describe('EvidenceController', () => {
  let controller: EvidenceController;
  let evidenceService: {
    listEvidence: jest.Mock;
    getEvidenceOrFail: jest.Mock;
    listEvidenceVersions: jest.Mock;
    getContentDigest: jest.Mock;
    getSafeGateway: jest.Mock;
    getAvailabilityStatus: jest.Mock;
  };
  let flagService: {
    createFlag: jest.Mock;
    getFlagsForEvidence: jest.Mock;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EvidenceController],
      providers: [
        {
          provide: EvidenceFlagService,
          useValue: {
            createFlag: jest.fn(),
            getFlagsForEvidence: jest.fn(),
          },
        },
        {
          provide: EvidenceService,
          useValue: {
            listEvidence: jest.fn(),
            getEvidenceOrFail: jest.fn(),
            listEvidenceVersions: jest.fn(),
            getContentDigest: jest.fn(),
            getSafeGateway: jest.fn(),
            getAvailabilityStatus: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<EvidenceController>(EvidenceController);
    evidenceService = module.get(EvidenceService);
    flagService = module.get(EvidenceFlagService);
  });

  it('is defined', () => {
    expect(controller).toBeDefined();
  });

  describe('listEvidence', () => {
    it('delegates to service', async () => {
      const res = {
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      } as Paginated<unknown>;
      evidenceService.listEvidence.mockResolvedValue(res);
      const query = { page: 1, limit: 20 };
      await expect(controller.listEvidence(query)).resolves.toBe(res);
      expect(evidenceService.listEvidence).toHaveBeenCalledWith(query);
    });
  });

  describe('getEvidence', () => {
    it('delegates and passes through errors', async () => {
      evidenceService.getEvidenceOrFail.mockRejectedValue(
        new Error('not found'),
      );
      await expect(controller.getEvidence('ev-1')).rejects.toThrow('not found');
      expect(evidenceService.getEvidenceOrFail).toHaveBeenCalledWith('ev-1');
    });
  });

  describe('listVersions', () => {
    it('delegates with query', async () => {
      evidenceService.listEvidenceVersions.mockResolvedValue({});
      await expect(
        controller.listVersions('ev-1', { page: 1, limit: 10 }),
      ).resolves.toEqual({});
      expect(evidenceService.listEvidenceVersions).toHaveBeenCalledWith(
        'ev-1',
        {
          page: 1,
          limit: 10,
        },
      );
    });
  });

  describe('getDigest', () => {
    it('passes the optional version', async () => {
      evidenceService.getContentDigest.mockResolvedValue({ digestHex: 'ab' });
      await expect(
        controller.getDigest('ev-1', { version: 2 }),
      ).resolves.toEqual({ digestHex: 'ab' });
      expect(evidenceService.getContentDigest).toHaveBeenCalledWith('ev-1', 2);
    });
  });

  describe('getGateway', () => {
    it('passes the optional version', async () => {
      evidenceService.getSafeGateway.mockResolvedValue({ cid: 'c' });
      await expect(controller.getGateway('ev-1', {})).resolves.toEqual({
        cid: 'c',
      });
      expect(evidenceService.getSafeGateway).toHaveBeenCalledWith(
        'ev-1',
        undefined,
      );
    });
  });

  describe('getStatus', () => {
    it('returns the availability status', async () => {
      evidenceService.getAvailabilityStatus.mockResolvedValue({
        availability: EvidenceAvailability.AVAILABLE,
      });
      await expect(controller.getStatus('ev-1')).resolves.toEqual({
        availability: EvidenceAvailability.AVAILABLE,
      });
      expect(evidenceService.getAvailabilityStatus).toHaveBeenCalledWith(
        'ev-1',
      );
    });
  });

  describe('flagEvidence', () => {
    it('throws when reason is missing', async () => {
      type FlagBody = Parameters<typeof controller.flagEvidence>[1];
      const emptyBody = {} as unknown as FlagBody;
      await expect(controller.flagEvidence('ev-1', emptyBody)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('delegates to flag service', async () => {
      flagService.createFlag.mockResolvedValue({ id: 'flag-1' });
      await expect(
        controller.flagEvidence('ev-1', { reason: 'spam' }),
      ).resolves.toEqual({ id: 'flag-1' });
      expect(flagService.createFlag).toHaveBeenCalledWith(
        'ev-1',
        'spam',
        undefined,
      );
    });
  });

  describe('getFlags', () => {
    it('forbids non-admin access', async () => {
      await expect(controller.getFlags('ev-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('returns flags for admin', async () => {
      flagService.getFlagsForEvidence.mockResolvedValue([]);
      const res = await controller.getFlags('ev-1', 'true');
      expect(flagService.getFlagsForEvidence).toHaveBeenCalledWith('ev-1');
      expect(res).toEqual([]);
    });
  });
});

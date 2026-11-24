import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { SybilResistanceController } from './sybil-resistance.controller';
import { SybilResistanceService } from './sybil-resistance.service';

describe('SybilResistanceController', () => {
  let controller: SybilResistanceController;
  let service: any;

  const mockUserId = 'usr-ctrl-001';

  beforeEach(async () => {
    service = {
      recordSybilScore: jest
        .fn()
        .mockResolvedValue({ id: 'rec-1', compositeScore: 0.85 }),
      getLatestSybilScore: jest
        .fn()
        .mockResolvedValue({ id: 'rec-1', compositeScore: 0.85 }),
      getPublicSybilScore: jest.fn().mockResolvedValue({
        userId: mockUserId,
        score: 0.85,
        riskScore: 0.15,
        riskLevel: 'LOW',
        version: '1.0.0',
        provenanceDigest: 'a'.repeat(64),
      }),
      recomputeScore: jest.fn().mockResolvedValue({
        score: 0.85,
        riskScore: 0.15,
        riskLevel: 'LOW',
        version: '1.0.0',
      }),
      submitAppeal: jest.fn().mockResolvedValue({
        appealId: 'app-1',
        userId: mockUserId,
        status: 'RESOLVED',
        reason: 'Valid justification',
      }),
      getAppeals: jest
        .fn()
        .mockResolvedValue([{ appealId: 'app-1', status: 'RESOLVED' }]),
      getModelVersions: jest
        .fn()
        .mockReturnValue([{ version: '1.0.0' }, { version: '2.0.0' }]),
      getSybilScoreHistory: jest.fn().mockResolvedValue([{ id: 'rec-1' }]),
      getSybilScoreForVoting: jest
        .fn()
        .mockResolvedValue({ userId: mockUserId, score: 0.85 }),
      setWorldcoinVerified: jest.fn().mockResolvedValue({ id: 'rec-2' }),
      recalculateAllScores: jest
        .fn()
        .mockResolvedValue([{ userId: mockUserId, success: true }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SybilResistanceController],
      providers: [
        {
          provide: SybilResistanceService,
          useValue: service,
        },
      ],
    }).compile();

    controller = module.get<SybilResistanceController>(
      SybilResistanceController,
    );
  });

  describe('recordScore', () => {
    it('calls service.recordSybilScore with valid userId', async () => {
      const res = await controller.recordScore(mockUserId);
      expect(res).toEqual({ id: 'rec-1', compositeScore: 0.85 });
      expect(service.recordSybilScore).toHaveBeenCalledWith(mockUserId);
    });

    it('throws BadRequestException when userId is empty', async () => {
      await expect(controller.recordScore('')).rejects.toThrow(
        BadRequestException,
      );
      await expect(controller.recordScore('   ')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getLatestScore', () => {
    it('returns latest score', async () => {
      const res = await controller.getLatestScore(mockUserId);
      expect(res).toEqual({ id: 'rec-1', compositeScore: 0.85 });
      expect(service.getLatestSybilScore).toHaveBeenCalledWith(mockUserId);
    });

    it('throws BadRequestException for invalid userId', async () => {
      await expect(controller.getLatestScore('')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getPublicScore', () => {
    it('returns privacy-safe public score view', async () => {
      const res = await controller.getPublicScore(mockUserId);
      expect(res.userId).toBe(mockUserId);
      expect(res.score).toBe(0.85);
      expect(res.riskScore).toBe(0.15);
      expect(service.getPublicSybilScore).toHaveBeenCalledWith(mockUserId);
    });

    it('throws BadRequestException for invalid userId', async () => {
      await expect(controller.getPublicScore('')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('recomputeScore', () => {
    it('triggers deterministic recomputation with options', async () => {
      const options = { pinnedVersion: '2.0.0' };
      const res = await controller.recomputeScore(mockUserId, options);
      expect(res.score).toBe(0.85);
      expect(service.recomputeScore).toHaveBeenCalledWith(mockUserId, options);
    });

    it('throws BadRequestException for invalid userId', async () => {
      await expect(controller.recomputeScore('', {})).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('submitAppeal and getAppeals', () => {
    it('submits appeal with valid reason', async () => {
      const body = { reason: 'Newly verified Orb' };
      const res = await controller.submitAppeal(mockUserId, body);
      expect(res.status).toBe('RESOLVED');
      expect(service.submitAppeal).toHaveBeenCalledWith(mockUserId, body);
    });

    it('throws BadRequestException when appeal reason is missing or empty', async () => {
      await expect(
        controller.submitAppeal(mockUserId, { reason: '' } as any),
      ).rejects.toThrow(BadRequestException);

      await expect(
        controller.submitAppeal(mockUserId, null as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns appeal history for user', async () => {
      const res = await controller.getAppeals(mockUserId);
      expect(res).toHaveLength(1);
      expect(service.getAppeals).toHaveBeenCalledWith(mockUserId);
    });
  });

  describe('getModels', () => {
    it('returns available scoring model versions', async () => {
      const res = await controller.getModels();
      expect(res).toHaveLength(2);
      expect(service.getModelVersions).toHaveBeenCalled();
    });
  });

  describe('other endpoints', () => {
    it('fetches history, voting format, and admin recalculation', async () => {
      await controller.getScoreHistory(mockUserId);
      expect(service.getSybilScoreHistory).toHaveBeenCalledWith(mockUserId);

      await controller.getScoreForVoting(mockUserId);
      expect(service.getSybilScoreForVoting).toHaveBeenCalledWith(mockUserId);

      await controller.setWorldcoinVerified(mockUserId, { verified: true });
      expect(service.setWorldcoinVerified).toHaveBeenCalledWith(
        mockUserId,
        true,
      );

      await controller.recalculateAll();
      expect(service.recalculateAllScores).toHaveBeenCalled();
    });
  });
});

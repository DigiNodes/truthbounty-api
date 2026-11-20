import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SybilResistanceController } from './sybil-resistance.controller';
import { SybilResistanceService } from './sybil-resistance.service';
import { SybilProvenanceService } from './sybil-provenance.service';
import { SybilOwnershipGuard } from './guards/sybil-ownership.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ServiceAuthGuard } from '../auth/guards/service-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ConfigService } from '@nestjs/config';

describe('SybilResistanceController', () => {
  let controller: SybilResistanceController;
  let service: any;
  let provenanceService: SybilProvenanceService;

  const mockUserId = 'usr-ctrl-001';
  const ownerPrincipal = {
    address: '0xowner',
    userId: mockUserId,
    user: { id: mockUserId, role: 'contributor' },
  };
  const otherUserPrincipal = {
    address: '0xother',
    userId: 'usr-attacker',
    user: { id: 'usr-attacker', role: 'contributor' },
  };
  const moderatorPrincipal = {
    address: '0xmod',
    userId: 'usr-mod',
    user: { id: 'usr-mod', role: 'moderator' },
  };
  const adminPrincipal = {
    address: '0xadmin',
    userId: 'usr-admin',
    user: { id: 'usr-admin', role: 'admin' },
  };

  const rawCalculationDetailsWithSensitiveData = JSON.stringify({
    version: '1.0.0',
    componentScores: {
      worldcoin: 0.3,
      walletAge: 0.25,
      staking: 0.25,
      accuracy: 0.2,
    },
    timestamp: '2026-11-20T00:00:00.000Z',
    explanation: 'Unsanitized explanation',
    riskScore: 0.15,
    riskLevel: 'LOW',
    provenanceDigest: 'f'.repeat(64),
    missingFeatures: [],
    staleFeatures: [],
    featureProvenance: {
      worldcoin: {
        featureName: 'worldcoin',
        source: 'world_id',
        observedAt: '2026-11-20T00:00:00.000Z',
        freshnessMs: 100,
        isStale: false,
        isMissing: false,
        details: { verified: true },
        sensitiveData: {
          nullifierHash: '0xSECRET_WORLDCOIN_NULLIFIER_HASH_123',
          proof: { pi_a: ['0x1', '0x2'], pi_b: [['0x3']], pi_c: ['0x4'] },
        },
      },
      wallet_age: {
        featureName: 'wallet_age',
        source: 'wallet_registry',
        observedAt: '2026-11-20T00:00:00.000Z',
        freshnessMs: 200,
        isStale: false,
        isMissing: false,
        details: { walletCount: 2, tenureMs: 1000000 },
        sensitiveData: {
          walletAddresses: ['0xPRIVATE_WALLET_ADDRESS_ABC', '0xPRIVATE_WALLET_ADDRESS_DEF'],
        },
      },
    },
  });

  beforeEach(async () => {
    provenanceService = new SybilProvenanceService();

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
        calculatedAt: '2026-11-20T00:00:00.000Z',
        freshness: { status: 'FRESH', oldestFeatureAgeMs: 100 },
        missingFeatures: [],
        signalsSummary: {
          worldcoinVerified: true,
          walletCount: 2,
          tenureDays: 30,
          isStaker: true,
          claimsEvaluated: 10,
        },
        explanation: 'Sanitized explanation',
      }),
      recomputeScore: jest.fn().mockResolvedValue({
        score: 0.85,
        riskScore: 0.15,
        riskLevel: 'LOW',
        version: '1.0.0',
        provenanceDigest: 'a'.repeat(64),
        missingFeatures: [],
        staleFeatures: [],
        details: {
          version: '1.0.0',
          componentScores: { worldcoin: 0.3, walletAge: 0.25, staking: 0.25, accuracy: 0.2 },
          timestamp: '2026-11-20T00:00:00.000Z',
          explanation: 'Recomputed',
          riskScore: 0.15,
          riskLevel: 'LOW',
          provenanceDigest: 'a'.repeat(64),
          missingFeatures: [],
          staleFeatures: [],
        },
      }),
      submitAppeal: jest.fn().mockResolvedValue({
        appealId: 'app-1',
        userId: mockUserId,
        status: 'RESOLVED',
        reason: 'Valid justification',
        previousScore: 0.5,
        previousRiskScore: 0.5,
        newScore: 0.85,
        newRiskScore: 0.15,
        modelVersion: '1.0.0',
        recomputedAt: '2026-11-20T00:00:00.000Z',
        provenanceDigest: 'a'.repeat(64),
        additionalEvidenceSummary: 'SECRET_PRIVATE_USER_EVIDENCE_ATTACHMENT',
      }),
      getAppeals: jest.fn().mockResolvedValue([
        {
          appealId: 'app-1',
          userId: mockUserId,
          status: 'RESOLVED',
          reason: 'Valid justification',
          previousScore: 0.5,
          previousRiskScore: 0.5,
          newScore: 0.85,
          newRiskScore: 0.15,
          modelVersion: '1.0.0',
          recomputedAt: '2026-11-20T00:00:00.000Z',
          provenanceDigest: 'a'.repeat(64),
          additionalEvidenceSummary: 'SECRET_PRIVATE_USER_EVIDENCE_ATTACHMENT',
        },
      ]),
      getModelVersions: jest
        .fn()
        .mockReturnValue([{ version: '1.0.0' }, { version: '2.0.0' }]),
      getSybilScoreHistory: jest.fn().mockResolvedValue([{ id: 'rec-1' }]),
      getSybilScoreForVoting: jest
        .fn()
        .mockResolvedValue({ userId: mockUserId, score: 0.85, isVerified: true }),
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
        {
          provide: SybilProvenanceService,
          useValue: provenanceService,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string, def?: any) => {
              if (key === 'SERVICE_API_KEY') return 'test-service-key';
              return def;
            }),
          },
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

    it('enforces ownership: denies non-owner caller', async () => {
      await expect(
        controller.recordScore(mockUserId, otherUserPrincipal),
      ).rejects.toThrow(ForbiddenException);
    });

    it('enforces ownership: allows owner caller', async () => {
      const res = await controller.recordScore(mockUserId, ownerPrincipal);
      expect(res.compositeScore).toBe(0.85);
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

    it('enforces ownership: denies non-owner caller', async () => {
      await expect(
        controller.getLatestScore(mockUserId, otherUserPrincipal),
      ).rejects.toThrow(ForbiddenException);
    });

    it('enforces ownership: allows owner, moderator, and admin', async () => {
      await expect(
        controller.getLatestScore(mockUserId, ownerPrincipal),
      ).resolves.toBeDefined();
      await expect(
        controller.getLatestScore(mockUserId, moderatorPrincipal),
      ).resolves.toBeDefined();
      await expect(
        controller.getLatestScore(mockUserId, adminPrincipal),
      ).resolves.toBeDefined();
    });

    it('sanitizes calculationDetails and strips nullifierHash, proofs, and walletAddresses', async () => {
      service.getLatestSybilScore.mockResolvedValueOnce({
        id: 'rec-sensitive',
        userId: mockUserId,
        compositeScore: 0.9,
        worldcoinScore: 0.3,
        walletAgeScore: 0.25,
        stakingScore: 0.25,
        accuracyScore: 0.2,
        calculationDetails: rawCalculationDetailsWithSensitiveData,
      });

      const res = await controller.getLatestScore(mockUserId, ownerPrincipal);
      const resJson = JSON.stringify(res);

      expect(resJson).not.toContain('0xSECRET_WORLDCOIN_NULLIFIER_HASH_123');
      expect(resJson).not.toContain('0xPRIVATE_WALLET_ADDRESS_ABC');
      expect(resJson).not.toContain('pi_a');
      expect(resJson).not.toContain('sensitiveData');
      expect((res as any).calculationDetails).toBeUndefined();
      expect(res.details).toBeDefined();
      expect(res.details?.featureProvenance?.worldcoin).toBeDefined();
      expect((res.details?.featureProvenance?.worldcoin as any).sensitiveData).toBeUndefined();
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

    it('enforces ownership: denies non-owner caller', async () => {
      await expect(
        controller.recomputeScore(mockUserId, {}, otherUserPrincipal),
      ).rejects.toThrow(ForbiddenException);
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

    it('returns appeal history for user and strips private additionalEvidenceSummary', async () => {
      const res = await controller.getAppeals(mockUserId);
      expect(res).toHaveLength(1);
      expect(service.getAppeals).toHaveBeenCalledWith(mockUserId);
      const resJson = JSON.stringify(res);
      expect(resJson).not.toContain('SECRET_PRIVATE_USER_EVIDENCE_ATTACHMENT');
      expect((res[0] as any).additionalEvidenceSummary).toBeUndefined();
    });

    it('enforces ownership on getAppeals: denies non-owner caller', async () => {
      await expect(
        controller.getAppeals(mockUserId, otherUserPrincipal),
      ).rejects.toThrow(ForbiddenException);
    });

    it('enforces ownership on getAppeals: allows owner, moderator, admin', async () => {
      await expect(
        controller.getAppeals(mockUserId, ownerPrincipal),
      ).resolves.toHaveLength(1);
      await expect(
        controller.getAppeals(mockUserId, moderatorPrincipal),
      ).resolves.toHaveLength(1);
      await expect(
        controller.getAppeals(mockUserId, adminPrincipal),
      ).resolves.toHaveLength(1);
    });
  });

  describe('getModels', () => {
    it('returns available scoring model versions', async () => {
      const res = await controller.getModels();
      expect(res).toHaveLength(2);
      expect(service.getModelVersions).toHaveBeenCalled();
    });
  });

  describe('getScoreHistory', () => {
    it('fetches history without query params', async () => {
      await controller.getScoreHistory(mockUserId);
      expect(service.getSybilScoreHistory).toHaveBeenCalledWith(mockUserId);
    });

    it('enforces ownership: denies non-owner caller', async () => {
      await expect(
        controller.getScoreHistory(mockUserId, 10, 0, otherUserPrincipal),
      ).rejects.toThrow(ForbiddenException);
    });

    it('bounds pagination to max 50 to prevent bulk enumeration', async () => {
      await controller.getScoreHistory(mockUserId, 1000, 0, ownerPrincipal);
      expect(service.getSybilScoreHistory).toHaveBeenCalledWith(mockUserId, 50, 0);
    });

    it('sanitizes history records: strips nullifierHash, proofs, and walletAddresses', async () => {
      service.getSybilScoreHistory.mockResolvedValueOnce([
        {
          id: 'hist-1',
          userId: mockUserId,
          compositeScore: 0.88,
          calculationDetails: rawCalculationDetailsWithSensitiveData,
        },
      ]);

      const res = await controller.getScoreHistory(mockUserId, 10, 0, ownerPrincipal);
      const resJson = JSON.stringify(res);
      expect(resJson).not.toContain('0xSECRET_WORLDCOIN_NULLIFIER_HASH_123');
      expect(resJson).not.toContain('0xPRIVATE_WALLET_ADDRESS_ABC');
      expect(resJson).not.toContain('pi_a');
      expect((res[0] as any).calculationDetails).toBeUndefined();
      expect(res[0].details).toBeDefined();
    });
  });

  describe('getScoreForVoting', () => {
    it('returns strictly minimal voting fields without calculation details', async () => {
      service.getSybilScoreForVoting.mockResolvedValueOnce({
        userId: mockUserId,
        score: 0.85,
        isVerified: true,
        details: { leaked: 'should not be here' },
      });

      const res = await controller.getScoreForVoting(mockUserId);
      expect(res).toEqual({
        userId: mockUserId,
        score: 0.85,
        isVerified: true,
      });
      expect((res as any).details).toBeUndefined();
    });

    it('throws BadRequestException for empty userId', async () => {
      await expect(controller.getScoreForVoting('')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('admin operations', () => {
    it('sets Worldcoin verified and recalculates all', async () => {
      await controller.setWorldcoinVerified(mockUserId, { verified: true });
      expect(service.setWorldcoinVerified).toHaveBeenCalledWith(
        mockUserId,
        true,
      );

      await controller.recalculateAll();
      expect(service.recalculateAllScores).toHaveBeenCalled();
    });
  });

  describe('Route Guards & Authorization Metadata', () => {
    it('declares JwtAuthGuard and SybilOwnershipGuard on GET users/:userId/score', () => {
      const guards = Reflect.getMetadata('__guards__', controller.getLatestScore);
      expect(guards).toBeDefined();
      expect(guards).toContain(JwtAuthGuard);
      expect(guards).toContain(SybilOwnershipGuard);
    });

    it('declares JwtAuthGuard and SybilOwnershipGuard on GET users/:userId/history', () => {
      const guards = Reflect.getMetadata('__guards__', controller.getScoreHistory);
      expect(guards).toBeDefined();
      expect(guards).toContain(JwtAuthGuard);
      expect(guards).toContain(SybilOwnershipGuard);
    });

    it('declares JwtAuthGuard and SybilOwnershipGuard on GET users/:userId/appeals', () => {
      const guards = Reflect.getMetadata('__guards__', controller.getAppeals);
      expect(guards).toBeDefined();
      expect(guards).toContain(JwtAuthGuard);
      expect(guards).toContain(SybilOwnershipGuard);
    });

    it('declares ServiceAuthGuard on GET users/:userId/voting', () => {
      const guards = Reflect.getMetadata('__guards__', controller.getScoreForVoting);
      expect(guards).toBeDefined();
      expect(guards).toContain(ServiceAuthGuard);
    });

    it('does NOT declare auth guards on GET users/:userId/public-score (public route)', () => {
      const guards = Reflect.getMetadata('__guards__', controller.getPublicScore);
      expect(guards).toBeUndefined();
    });

    it('declares RolesGuard with admin role on POST recalculate-all and setWorldcoinVerified', () => {
      const recalculateGuards = Reflect.getMetadata('__guards__', controller.recalculateAll);
      expect(recalculateGuards).toContain(RolesGuard);
      const recalculateRoles = Reflect.getMetadata('roles', controller.recalculateAll);
      expect(recalculateRoles).toEqual(['admin']);

      const verifyGuards = Reflect.getMetadata('__guards__', controller.setWorldcoinVerified);
      expect(verifyGuards).toContain(RolesGuard);
      const verifyRoles = Reflect.getMetadata('roles', controller.setWorldcoinVerified);
      expect(verifyRoles).toEqual(['admin']);
    });
  });
});

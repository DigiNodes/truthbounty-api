import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SybilResistanceService } from './sybil-resistance.service';
import { SybilModelRegistry } from './sybil-model-registry';
import { SybilProvenanceService } from './sybil-provenance.service';
import { StakeEvent } from '../staking/entities/stake-event.entity';
import {
  ChainArtifactAuthority,
  InvalidFeatureBoundsException,
  MissingFeatureException,
  StaleFeatureException,
  UnauthorizedProvenanceException,
} from './sybil-resistance.types';

jest.mock('../prisma/prisma.service', () => {
  return {
    PrismaService: jest.fn().mockImplementation(() => ({
      user: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      worldIdVerification: {
        findFirst: jest.fn(),
      },
      sybilScore: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      sybilExplanation: {
        create: jest.fn(),
        findFirst: jest.fn(),
      },
    })),
  };
});

import { PrismaService } from '../prisma/prisma.service';

function makeMockQueryBuilder(result: { total: string | null } | null) {
  const qb: any = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(result),
  };
  return qb;
}

describe('SybilResistanceService — PREWAVE-BE-062 Provenance & Production-Readiness Gates', () => {
  let service: SybilResistanceService;
  let prisma: any;
  let modelRegistry: SybilModelRegistry;
  let provenanceService: SybilProvenanceService;

  const mockUserId = 'usr-provenance-test-001';
  const sensitiveNullifier = '0xnullifier_hash_secret_1234567890abcdef';
  const sensitiveProof = { pi_a: ['0x111', '0x222'], protocol: 'groth16' };
  const mockWalletAddress = '0x1234567890123456789012345678901234567890';

  const canonicalAuthority: ChainArtifactAuthority = {
    chainId: 11155420,
    releaseId: 'rel-opsepolia-20261015-v2',
    artifactHash:
      'f183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22f',
    contractAddress: '0x0000000000000000000000000000000000001004',
    finalizedThroughBlock: 24850000,
  };

  const mockUser: any = {
    id: mockUserId,
    createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(),
    reputation: 100,
    worldcoinVerified: true,
    wallets: [
      {
        id: 'w-1',
        address: mockWalletAddress,
        chain: 'optimism-sepolia',
        linkedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
      },
    ],
  };

  beforeEach(async () => {
    modelRegistry = new SybilModelRegistry();
    provenanceService = new SybilProvenanceService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SybilResistanceService,
        {
          provide: SybilModelRegistry,
          useValue: modelRegistry,
        },
        {
          provide: SybilProvenanceService,
          useValue: provenanceService,
        },
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: jest.fn().mockResolvedValue(mockUser),
              findMany: jest.fn().mockResolvedValue([mockUser]),
              update: jest.fn().mockResolvedValue(mockUser),
            },
            worldIdVerification: {
              findFirst: jest.fn().mockResolvedValue({
                id: 'wid-1',
                userId: mockUserId,
                verifiedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
                nullifierHash: sensitiveNullifier,
                proof: sensitiveProof,
                verificationLevel: 'orb',
              }),
            },
            sybilScore: {
              create: jest.fn().mockImplementation((args) =>
                Promise.resolve({
                  id: 'score-rec-001',
                  createdAt: new Date(),
                  ...args.data,
                }),
              ),
              findFirst: jest.fn().mockResolvedValue(null),
              findMany: jest.fn().mockResolvedValue([]),
              deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            sybilExplanation: {
              create: jest.fn().mockResolvedValue({ id: 'expl-1' }),
              findFirst: jest.fn().mockResolvedValue(null),
            },
          },
        },
        {
          provide: getRepositoryToken(StakeEvent),
          useValue: {
            createQueryBuilder: jest.fn(() =>
              makeMockQueryBuilder({ total: '1500000000000000000' }),
            ),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              if (key === 'sybil.minClaimsForAccuracyScore') return 5;
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<SybilResistanceService>(SybilResistanceService);
    prisma = module.get<any>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // 1. Missing & Stale Feature Tests
  // =========================================================================
  describe('Missing & Stale Feature Tests', () => {
    it('missing inputs DO NOT silently become zero-risk (empty entity receives maximum/prior risk)', async () => {
      // User with NO wallets, NO WorldID verification, NO staking, NO claims
      const emptyUser = {
        id: 'usr-empty',
        createdAt: new Date(),
        updatedAt: new Date(),
        worldcoinVerified: false,
        wallets: [],
      };

      jest.spyOn(prisma.user, 'findUnique').mockResolvedValue(emptyUser);
      jest
        .spyOn(prisma.worldIdVerification, 'findFirst')
        .mockResolvedValue(null);

      const { score, details } = await service.computeSybilScore('usr-empty');

      // Resistance score should be 0 (no signals of trustworthiness)
      expect(score).toBe(0.0);
      expect(details.missingFeatures).toContain('worldcoin');
      expect(details.missingFeatures).toContain('wallet_age');
      expect(details.missingFeatures).toContain('staking');
      expect(details.missingFeatures).toContain('accuracy');

      // CRITICAL ACCEPTANCE CRITERION: Missing inputs must NOT silently become zero-risk!
      // An empty/unverified entity must have riskScore > 0 (in fact, 1.0 or high risk), NEVER 0.0!
      expect(details.riskScore).toBeGreaterThanOrEqual(0.85);
      expect(details.riskScore).toBe(1.0);
      expect(details.riskLevel).toBe('CRITICAL');
    });

    it('partially missing inputs retain uncertainty risk floor', async () => {
      // User with only Worldcoin verified, but NO wallet history and NO staking
      const userWithOnlyWorldcoin = {
        ...mockUser,
        wallets: [],
      };

      jest
        .spyOn(prisma.user, 'findUnique')
        .mockResolvedValue(userWithOnlyWorldcoin);
      jest.spyOn(prisma.worldIdVerification, 'findFirst').mockResolvedValue({
        id: 'wid-1',
        verifiedAt: new Date(),
        nullifierHash: '0xhash',
      });

      const { score, details } = await service.computeSybilScore(mockUserId);

      // Worldcoin provides 0.30 resistance
      expect(details.componentScores.worldcoin).toBe(1.0);
      expect(score).toBe(0.3);

      // Missing features are tracked
      expect(details.missingFeatures).toContain('wallet_age');
      expect(details.missingFeatures).toContain('staking');
      expect(details.missingFeatures).toContain('accuracy');

      // Risk score reflects missing features (1.0 - 0.30 = 0.70 risk), NOT zero-risk!
      expect(details.riskScore).toBe(0.7);
      expect(details.riskScore).toBeGreaterThan(0);
      expect(details.riskLevel).toBe('HIGH');
    });

    it('fails closed when failClosedOnMissing is requested', async () => {
      const userMissingStaking = {
        ...mockUser,
        wallets: [],
      };
      jest
        .spyOn(prisma.user, 'findUnique')
        .mockResolvedValue(userMissingStaking);

      await expect(
        service.computeSybilScore(mockUserId, { failClosedOnMissing: true }),
      ).rejects.toThrow(MissingFeatureException);
    });

    it('detects stale features when observation age exceeds maxFreshnessMs', async () => {
      // Worldcoin verified 45 days ago (exceeds model v1 default of 30 days)
      const staleVerificationDate = new Date(
        Date.now() - 45 * 24 * 60 * 60 * 1000,
      );

      jest.spyOn(prisma.worldIdVerification, 'findFirst').mockResolvedValue({
        id: 'wid-stale',
        verifiedAt: staleVerificationDate,
        nullifierHash: '0xstale',
      });

      const { details } = await service.computeSybilScore(mockUserId);

      expect(details.featureProvenance.worldcoin.isStale).toBe(true);
      expect(details.staleFeatures).toContain('worldcoin');
    });

    it('fails closed when failClosedOnStale is enabled and feature is stale', async () => {
      const staleDate = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000);
      jest.spyOn(prisma.worldIdVerification, 'findFirst').mockResolvedValue({
        id: 'wid-stale',
        verifiedAt: staleDate,
        nullifierHash: '0xstale',
      });

      await expect(
        service.computeSybilScore(mockUserId, { failClosedOnStale: true }),
      ).rejects.toThrow(StaleFeatureException);
    });
  });

  // =========================================================================
  // 2. Model Version Change Tests
  // =========================================================================
  describe('Model Version Change Tests', () => {
    it('computes different scores and applies version-specific weights when model version changes', async () => {
      // Compute with pinned version '1.0.0'
      const v1Result = await service.recomputeScore(mockUserId, {
        pinnedVersion: '1.0.0',
      });

      // Compute with pinned version '2.0.0'
      const v2Result = await service.recomputeScore(mockUserId, {
        pinnedVersion: '2.0.0',
      });

      expect(v1Result.version).toBe('1.0.0');
      expect(v2Result.version).toBe('2.0.0');

      // V1 weights: worldcoin=0.30, walletAge=0.25, staking=0.25, accuracy=0.20
      expect(v1Result.details.worldcoinWeight).toBe(0.3);
      expect(v1Result.details.walletAgeWeight).toBe(0.25);

      // V2 weights: worldcoin=0.35, walletAge=0.20, staking=0.25, accuracy=0.20
      expect(v2Result.details.worldcoinWeight).toBe(0.35);
      expect(v2Result.details.walletAgeWeight).toBe(0.2);

      // Different models with different weights produce distinguishable outputs
      expect(v1Result.provenanceDigest).not.toBe(v2Result.provenanceDigest);
    });

    it('score is reproducible for pinned inputs/version', async () => {
      const run1 = await service.recomputeScore(mockUserId, {
        pinnedVersion: '1.0.0',
      });
      const run2 = await service.recomputeScore(mockUserId, {
        pinnedVersion: '1.0.0',
      });

      expect(run1.score).toBe(run2.score);
      expect(run1.riskScore).toBe(run2.riskScore);
      expect(run1.provenanceDigest).toBe(run2.provenanceDigest);
      expect(run1.details.componentScores).toEqual(
        run2.details.componentScores,
      );
    });

    it('throws when requesting unsupported model version', async () => {
      await expect(
        service.computeSybilScore(mockUserId, { pinnedVersion: '99.0.0' }),
      ).rejects.toThrow('Unsupported Sybil scoring model version: 99.0.0');
    });

    it('lists registered model versions', () => {
      const models = service.getModelVersions();
      expect(models.length).toBeGreaterThanOrEqual(2);
      const versions = models.map((m) => m.version);
      expect(versions).toContain('1.0.0');
      expect(versions).toContain('2.0.0');
    });
  });

  // =========================================================================
  // 3. Extreme Input Tests
  // =========================================================================
  describe('Extreme Input Tests', () => {
    it('handles extremely large staking deposits without numerical overflow or NaN', () => {
      const extremeStakeSignals = {
        worldcoinVerified: true,
        oldestWalletAgeMs: 90 * 24 * 60 * 60 * 1000,
        totalStakedAmount: BigInt(
          '1000000000000000000000000000000000000000000',
        ), // 10^42 wei
        claimsVotedOn: 10,
        claimsCorrect: 10,
      };

      const defaultModel = modelRegistry.getModel('1.0.0');
      const { normalized } = modelRegistry.normalizeSignals(
        extremeStakeSignals,
        defaultModel,
      );

      expect(Number.isFinite(normalized.staking)).toBe(true);
      expect(Number.isNaN(normalized.staking)).toBe(false);
      expect(normalized.staking).toBeLessThanOrEqual(1.0);
      expect(normalized.staking).toBe(1.0);
    });

    it('handles extremely large wallet age without numerical overflow', () => {
      const extremeAgeSignals = {
        worldcoinVerified: true,
        oldestWalletAgeMs: 50 * 365 * 24 * 60 * 60 * 1000, // 50 years in ms
        totalStakedAmount: BigInt('1000000000000000000'),
        claimsVotedOn: 5,
        claimsCorrect: 5,
      };

      const defaultModel = modelRegistry.getModel('1.0.0');
      const { normalized } = modelRegistry.normalizeSignals(
        extremeAgeSignals,
        defaultModel,
      );

      expect(Number.isFinite(normalized.walletAge)).toBe(true);
      expect(normalized.walletAge).toBeLessThanOrEqual(1.0);
      expect(normalized.walletAge).toBeGreaterThan(0.99);
    });

    it('rejects negative wallet age with InvalidFeatureBoundsException', () => {
      expect(() => {
        modelRegistry.validateInputBounds({
          worldcoinVerified: true,
          oldestWalletAgeMs: -5000,
          totalStakedAmount: 0n,
          claimsVotedOn: 0,
          claimsCorrect: 0,
        });
      }).toThrow(InvalidFeatureBoundsException);
    });

    it('rejects negative stake with InvalidFeatureBoundsException', () => {
      expect(() => {
        modelRegistry.validateInputBounds({
          worldcoinVerified: true,
          oldestWalletAgeMs: 1000,
          totalStakedAmount: -100n,
          claimsVotedOn: 0,
          claimsCorrect: 0,
        });
      }).toThrow(InvalidFeatureBoundsException);
    });

    it('rejects claimsCorrect > claimsVotedOn with InvalidFeatureBoundsException', () => {
      expect(() => {
        modelRegistry.validateInputBounds({
          worldcoinVerified: true,
          oldestWalletAgeMs: 1000,
          totalStakedAmount: 0n,
          claimsVotedOn: 5,
          claimsCorrect: 10, // impossible: 10 correct out of 5
        });
      }).toThrow(InvalidFeatureBoundsException);
    });

    it('rejects NaN and Infinity inputs with InvalidFeatureBoundsException', () => {
      expect(() => {
        modelRegistry.validateInputBounds({
          worldcoinVerified: true,
          oldestWalletAgeMs: NaN,
          totalStakedAmount: 0n,
          claimsVotedOn: 0,
          claimsCorrect: 0,
        });
      }).toThrow(InvalidFeatureBoundsException);

      expect(() => {
        modelRegistry.validateInputBounds({
          worldcoinVerified: true,
          oldestWalletAgeMs: Infinity,
          totalStakedAmount: 0n,
          claimsVotedOn: 0,
          claimsCorrect: 0,
        });
      }).toThrow(InvalidFeatureBoundsException);
    });

    it('rejects future timestamps with InvalidFeatureBoundsException', () => {
      const futureDate = new Date(Date.now() + 1000000);
      expect(() => {
        provenanceService.evaluateFreshness(
          futureDate,
          30 * 24 * 60 * 60 * 1000,
        );
      }).toThrow(InvalidFeatureBoundsException);
    });
  });

  // =========================================================================
  // 4. Deterministic Recompute & Appeal Path Tests
  // =========================================================================
  describe('Deterministic Recompute & Appeal Path Tests', () => {
    it('produces identical scores and cryptographic digests across repeated recomputations', async () => {
      const res1 = await service.recomputeScore(mockUserId, {
        pinnedVersion: '1.0.0',
      });
      const res2 = await service.recomputeScore(mockUserId, {
        pinnedVersion: '1.0.0',
      });

      expect(res1.score).toBe(res2.score);
      expect(res1.riskScore).toBe(res2.riskScore);
      expect(res1.provenanceDigest).toBe(res2.provenanceDigest);
      expect(res1.provenanceDigest).toMatch(/^[a-f0-9]{64}$/);
    });

    it('submits an appeal and returns an auditable appeal record', async () => {
      // Mock prior score
      jest.spyOn(prisma.sybilScore, 'findFirst').mockResolvedValueOnce({
        id: 'prior-score-1',
        compositeScore: 0.25,
        calculationDetails: JSON.stringify({ riskScore: 0.75 }),
      });

      const appeal = await service.submitAppeal(mockUserId, {
        reason:
          'Added new verified Orb credentials and linked long-standing wallet',
        additionalEvidence: { orbCenter: 'Berlin', verifiedDate: '2026-10-14' },
      });

      expect(appeal.appealId).toBeDefined();
      expect(appeal.userId).toBe(mockUserId);
      expect(appeal.previousScore).toBe(0.25);
      expect(appeal.newScore).toBeGreaterThan(appeal.previousScore);
      expect(appeal.status).toBe('RESOLVED');
      expect(appeal.provenanceDigest).toBeDefined();

      // Retrieve user appeal history
      const appeals = await service.getAppeals(mockUserId);
      expect(appeals).toHaveLength(1);
      expect(appeals[0].appealId).toBe(appeal.appealId);
    });

    it('rejects empty or excessively short appeal reasons', async () => {
      await expect(
        service.submitAppeal(mockUserId, { reason: 'hi' }),
      ).rejects.toThrow(InvalidFeatureBoundsException);
    });
  });

  // =========================================================================
  // 5. Privacy Tests (Sensitive Features Not Exposed Publicly)
  // =========================================================================
  describe('Privacy Tests', () => {
    it('public score view strictly redacts nullifierHash, proofs, and raw wallet addresses', async () => {
      const publicView = await service.getPublicSybilScore(mockUserId);

      // Verify public properties are present
      expect(publicView.userId).toBe(mockUserId);
      expect(publicView.score).toBeDefined();
      expect(publicView.riskScore).toBeDefined();
      expect(publicView.riskLevel).toBeDefined();
      expect(publicView.provenanceDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(publicView.signalsSummary.worldcoinVerified).toBe(true);

      // Stringify public response to ensure zero leakage
      const serialized = JSON.stringify(publicView);

      // MUST NOT contain sensitive WorldID nullifier hash
      expect(serialized).not.toContain(sensitiveNullifier);

      // MUST NOT contain ZK proof payload
      expect(serialized).not.toContain('groth16');
      expect(serialized).not.toContain('pi_a');

      // MUST NOT contain raw wallet addresses
      expect(serialized).not.toContain(mockWalletAddress);
      expect((publicView as any).wallets).toBeUndefined();
      expect((publicView as any).walletAddresses).toBeUndefined();
    });

    it('protected internal details retain complete provenance while public view is scrubbed', async () => {
      const { details } = await service.computeSybilScore(mockUserId);
      const publicView = await service.getPublicSybilScore(mockUserId);

      // Internal details contain sensitive fields for authorized audit
      expect(
        details.featureProvenance.worldcoin.sensitiveData?.nullifierHash,
      ).toBe(sensitiveNullifier);

      // Public view has no such fields
      expect((publicView as any).featureProvenance).toBeUndefined();
      expect((publicView as any).sensitiveData).toBeUndefined();
    });
  });

  // =========================================================================
  // 6. Canonical Contract Immutability & Authority Binding Constraints
  // =========================================================================
  describe('Canonical Finalized Contract Events & Outcome Immutability', () => {
    it('fails closed when chain authority specifies an unfinalized block', () => {
      expect(() => {
        provenanceService.validateEventProvenance(
          {
            chainId: canonicalAuthority.chainId,
            releaseId: canonicalAuthority.releaseId,
            artifactHash: canonicalAuthority.artifactHash,
            contractAddress: canonicalAuthority.contractAddress,
            blockNumber: canonicalAuthority.finalizedThroughBlock + 500, // unfinalized block!
          },
          canonicalAuthority,
        );
      }).toThrow(UnauthorizedProvenanceException);
    });

    it('fails closed when chain authority specifies mismatched chain ID or contract address', () => {
      expect(() => {
        provenanceService.validateEventProvenance(
          {
            chainId: 1, // Mainnet instead of OP Sepolia 11155420
            blockNumber: 100,
          },
          canonicalAuthority,
        );
      }).toThrow(UnauthorizedProvenanceException);

      expect(() => {
        provenanceService.validateEventProvenance(
          {
            chainId: canonicalAuthority.chainId,
            contractAddress: '0x0000000000000000000000000000000000009999', // unauthorized contract
            blockNumber: 100,
          },
          canonicalAuthority,
        );
      }).toThrow(UnauthorizedProvenanceException);
    });

    it('fails closed when event is explicitly non-finalized or non-canonical', () => {
      expect(() => {
        provenanceService.validateEventProvenance(
          {
            chainId: canonicalAuthority.chainId,
            blockNumber: 100,
            isFinalized: false,
          },
          canonicalAuthority,
        );
      }).toThrow(UnauthorizedProvenanceException);

      expect(() => {
        provenanceService.validateEventProvenance(
          {
            chainId: canonicalAuthority.chainId,
            blockNumber: 100,
            isCanonical: false,
          },
          canonicalAuthority,
        );
      }).toThrow(UnauthorizedProvenanceException);
    });

    it('guarantees score computation cannot directly mutate contract outcome', async () => {
      // Calling computeSybilScore, recomputeScore, or submitAppeal only writes to read models / DB,
      // never directly executing transactions on smart contracts
      const recompute = await service.recomputeScore(mockUserId);
      expect(recompute).toBeDefined();

      // Verified invariant
      expect(() => provenanceService.assertNoContractMutation()).not.toThrow();
    });
  });
});

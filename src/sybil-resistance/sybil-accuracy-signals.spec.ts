jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn().mockImplementation(() => ({})),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StakeEvent } from '../staking/entities/stake-event.entity';
import { PrismaService } from '../prisma/prisma.service';
import { ClaimAccuracyService } from './claim-accuracy.service';
import { SybilResistanceService } from './sybil-resistance.service';
import {
  ChainArtifactAuthority,
  MissingFeatureException,
  StaleFeatureException,
} from './sybil-resistance.types';

const WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';
const authority: ChainArtifactAuthority = {
  chainId: 11155420,
  releaseId: 'rel-opsepolia-20261015-v2',
  artifactHash:
    'f183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22f',
  contractAddress: '0x0000000000000000000000000000000000001002',
  finalizedThroughBlock: 24851000,
};

const user = {
  id: 'user-855',
  createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
  worldcoinVerified: false,
  wallets: [
    {
      address: WALLET_ADDRESS,
      chain: 'optimism-sepolia',
      linkedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
    },
  ],
};

function finalizeResult(
  claimsVotedOn: number,
  claimsCorrect: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    claimsVotedOn,
    claimsCorrect,
    observedAt: new Date(),
    provenance: {
      status: 'finalized',
      source: 'canonical_events',
      chainId: authority.chainId,
      releaseId: authority.releaseId,
      contractAddress: authority.contractAddress,
      finalizedThroughBlock: authority.finalizedThroughBlock,
      observedAt: new Date().toISOString(),
      canonicalEventCount: claimsVotedOn,
      eligibleEvaluationCount: claimsVotedOn,
      exclusions: {},
      ...overrides,
    },
  };
}

describe('SybilResistanceService — production accuracy signals (issue #855)', () => {
  let service: SybilResistanceService;
  let accuracyService: { deriveAccuracy: jest.Mock };

  beforeEach(async () => {
    accuracyService = {
      deriveAccuracy: jest.fn().mockResolvedValue(finalizeResult(4, 3)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SybilResistanceService,
        {
          provide: PrismaService,
          useValue: {
            user: { findUnique: jest.fn().mockResolvedValue(user) },
            worldIdVerification: {
              findFirst: jest.fn().mockResolvedValue(null),
            },
            sybilScore: {
              create: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
              deleteMany: jest.fn(),
            },
            sybilExplanation: { create: jest.fn(), findFirst: jest.fn() },
          },
        },
        {
          provide: getRepositoryToken(StakeEvent),
          useValue: {
            createQueryBuilder: jest.fn(() => ({
              select: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              getRawOne: jest.fn().mockResolvedValue({ total: null }),
            })),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: unknown) =>
              key === 'sybil.minClaimsForAccuracyScore' ? 3 : fallback,
          },
        },
        {
          provide: ClaimAccuracyService,
          useValue: accuracyService,
        },
      ],
    }).compile();

    service = module.get<SybilResistanceService>(SybilResistanceService);
  });

  it('uses derived production counts instead of hardcoded zeros', async () => {
    const { details } = await service.computeSybilScore(user.id);

    expect(accuracyService.deriveAccuracy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ address: WALLET_ADDRESS }),
      ]),
      undefined,
    );
    expect(details.componentScores.accuracy).toBe(0.75);
    expect(details.featureProvenance.accuracy.details).toEqual(
      expect.objectContaining({
        claimsVotedOn: 4,
        claimsCorrect: 3,
        status: 'finalized',
        eligibleEvaluationCount: 4,
      }),
    );
    expect(details.missingFeatures).not.toContain('accuracy');
  });

  it('passes the canonical authority through to accuracy derivation', async () => {
    await service.computeSybilScore(user.id, { authority });

    expect(accuracyService.deriveAccuracy).toHaveBeenCalledWith(
      expect.any(Array),
      authority,
    );
  });

  it('keeps accuracy explicitly missing and stale when canonical history is unavailable', async () => {
    accuracyService.deriveAccuracy.mockResolvedValue({
      claimsVotedOn: 0,
      claimsCorrect: 0,
      observedAt: null,
      provenance: {
        status: 'unavailable',
        source: 'canonical_events',
        observedAt: null,
        canonicalEventCount: 0,
        eligibleEvaluationCount: 0,
        exclusions: {},
        reason: 'checkpoint-missing',
      },
    });

    const { details } = await service.computeSybilScore(user.id);

    expect(details.missingFeatures).toContain('accuracy');
    expect(details.staleFeatures).toContain('accuracy');
    expect(details.featureProvenance.accuracy.details).toEqual(
      expect.objectContaining({
        status: 'unavailable',
        reason: 'checkpoint-missing',
      }),
    );
    await expect(
      service.computeSybilScore(user.id, { failClosedOnMissing: true }),
    ).rejects.toThrow(MissingFeatureException);
    await expect(
      service.computeSybilScore(user.id, { failClosedOnStale: true }),
    ).rejects.toThrow(StaleFeatureException);
  });

  it('still marks accuracy missing when derived activity is below the threshold', async () => {
    accuracyService.deriveAccuracy.mockResolvedValue(finalizeResult(2, 2));

    const { details } = await service.computeSybilScore(user.id);

    expect(details.componentScores.accuracy).toBe(0);
    expect(details.missingFeatures).toContain('accuracy');
  });
});

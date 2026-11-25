import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StakeEvent } from '../staking/entities/stake-event.entity';
import { CanonicalEvent } from '../v2/events/entities/canonical-event.entity';
import { EventCheckpoint } from '../v2/events/entities/event-checkpoint.entity';
import { PrismaService } from '../prisma/prisma.service';
import { ClaimAccuracyService } from './claim-accuracy.service';
import { SybilModelRegistry } from './sybil-model-registry';
import { SybilProvenanceService } from './sybil-provenance.service';
import { SybilResistanceService } from './sybil-resistance.service';
import {
  ChainArtifactAuthority,
  MissingFeatureException,
  StaleFeatureException,
} from './sybil-resistance.types';

const BINDING = {
  chainId: 11155420,
  releaseId: 'rel-opsepolia-20261015-v2',
  artifactHash:
    'f183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22f',
  verificationAddress: '0x0000000000000000000000000000000000001002',
  claimAddress: '0x0000000000000000000000000000000000001001',
  deploymentBlock: 24850000,
};

const authority: ChainArtifactAuthority = {
  chainId: BINDING.chainId,
  releaseId: BINDING.releaseId,
  artifactHash: BINDING.artifactHash,
  contractAddress: BINDING.verificationAddress,
  finalizedThroughBlock: BINDING.deploymentBlock + 1000,
};

const verifier = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const author = '0xcccccccccccccccccccccccccccccccccccccccc';

function tx(seed: number): string {
  return `0x${seed.toString(16).padStart(64, '0')}`;
}

function canonical(
  input: Partial<CanonicalEvent> & { eventName: string },
): CanonicalEvent {
  return {
    id: `event-${input.txHash}`,
    chainId: BINDING.chainId,
    contractAddress: BINDING.verificationAddress,
    artifactVersion: '2.0.0',
    eventSignature: null,
    txHash: tx(1),
    logIndex: 0,
    blockNumber: String(BINDING.deploymentBlock + 10),
    blockTimestamp: new Date('2026-11-19T00:00:00.000Z'),
    actor: null,
    claimId: null,
    roundId: null,
    asset: null,
    amount: null,
    payload: {},
    rawArgs: {},
    ingestedAt: new Date(),
    ...input,
  } as CanonicalEvent;
}

function finalizedHistory(
  correct: number,
  incorrect: number,
): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  let seed = 1;
  for (let i = 0; i < correct + incorrect; i += 1) {
    const claimId = `claim-${i}`;
    const verdict = i < correct;
    events.push(
      canonical({
        eventName: 'ClaimSubmitted',
        contractAddress: BINDING.claimAddress,
        claimId,
        actor: author,
        txHash: tx(seed++),
      }),
      canonical({
        eventName: 'VerdictSettled',
        claimId,
        payload: { finalVerdict: true },
        txHash: tx(seed++),
      }),
      canonical({
        eventName: 'VerificationRecorded',
        claimId,
        actor: verifier,
        payload: { verdict },
        txHash: tx(seed++),
        logIndex: seed,
      }),
    );
  }
  return events;
}

describe('Sybil production signal gathering — canonical claim accuracy', () => {
  let service: SybilResistanceService;
  let eventsRepo: any;
  let checkpointsRepo: any;
  let qb: any;

  beforeEach(async () => {
    qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    eventsRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    checkpointsRepo = {
      findOne: jest.fn().mockResolvedValue({
        lastFinalizedBlock: String(authority.finalizedThroughBlock),
        updatedAt: new Date('2026-11-20T00:00:00.000Z'),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SybilResistanceService,
        SybilModelRegistry,
        SybilProvenanceService,
        ClaimAccuracyService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: jest.fn().mockResolvedValue({
                id: 'user-1',
                worldcoinVerified: false,
                createdAt: new Date(),
                wallets: [
                  {
                    address: verifier,
                    chain: 'optimism-sepolia',
                    linkedAt: new Date(),
                  },
                ],
              }),
            },
            worldIdVerification: {
              findFirst: jest.fn().mockResolvedValue(null),
            },
            sybilScore: { create: jest.fn(), findFirst: jest.fn() },
            sybilExplanation: { create: jest.fn() },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: any) =>
              key === 'sybil.minClaimsForAccuracyScore' ? 3 : fallback,
            ),
          },
        },
        {
          provide: getRepositoryToken(StakeEvent),
          useValue: {
            createQueryBuilder: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              getRawOne: jest.fn().mockResolvedValue({ total: null }),
            }),
          },
        },
        { provide: getRepositoryToken(CanonicalEvent), useValue: eventsRepo },
        {
          provide: getRepositoryToken(EventCheckpoint),
          useValue: checkpointsRepo,
        },
      ],
    }).compile();

    service = module.get(SybilResistanceService);
  });

  it('returns derived counts from production gatherSignals instead of constants', async () => {
    qb.getMany.mockResolvedValue(finalizedHistory(4, 1));

    const signals = await (service as any).gatherSignals(
      { id: 'user-1' },
      [{ address: verifier, chain: 'optimism-sepolia', linkedAt: new Date() }],
      authority,
    );

    expect(signals.claimsVotedOn).toBe(5);
    expect(signals.claimsCorrect).toBe(4);
    expect(signals.claimsHistory.status).toBe('finalized');
    expect(signals.featuresObservedAt.accuracy).toBeInstanceOf(Date);
  });

  it('applies the configured accuracy weight when the eligible threshold is met', async () => {
    qb.getMany.mockResolvedValue(finalizedHistory(4, 1));

    const { score, details } = await service.computeSybilScore('user-1', {
      authority,
    });

    expect(details.componentScores.accuracy).toBeCloseTo(0.8, 4);
    expect(details.featureProvenance.accuracy.details).toMatchObject({
      claimsVotedOn: 5,
      claimsCorrect: 4,
      status: 'finalized',
      chainId: authority.chainId,
      releaseId: authority.releaseId,
      finalizedThroughBlock: authority.finalizedThroughBlock,
    });
    expect(details.missingFeatures).not.toContain('accuracy');
    expect(score).toBeCloseTo(0.16, 3);
  });

  it('marks accuracy explicitly missing when there are no eligible evaluations', async () => {
    qb.getMany.mockResolvedValue([]);

    const { details } = await service.computeSybilScore('user-1', {
      authority,
    });

    expect(details.missingFeatures).toContain('accuracy');
    expect(details.featureProvenance.accuracy.isMissing).toBe(true);
    expect(details.featureProvenance.accuracy.details.status).toBe('finalized');
  });

  it('surfaces unavailable canonical history and honors failClosedOnMissing', async () => {
    checkpointsRepo.findOne.mockResolvedValueOnce(null);

    const { details } = await service.computeSybilScore('user-1', {
      authority,
    });
    expect(details.missingFeatures).toContain('accuracy');
    expect(details.featureProvenance.accuracy.details.status).toBe(
      'unavailable',
    );
    expect(details.featureProvenance.accuracy.details.reason).toBe(
      'checkpoint-missing',
    );

    await expect(
      service.computeSybilScore('user-1', {
        authority,
        failClosedOnMissing: true,
      }),
    ).rejects.toThrow(MissingFeatureException);
  });

  it('surfaces stale finalized accuracy history and honors failClosedOnStale', async () => {
    const staleEvents = finalizedHistory(4, 1).map((event) => ({
      ...event,
      blockTimestamp: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    }));
    qb.getMany.mockResolvedValue(staleEvents);

    const { details } = await service.computeSybilScore('user-1', {
      authority,
    });
    expect(details.staleFeatures).toContain('accuracy');
    expect(details.featureProvenance.accuracy.isStale).toBe(true);

    await expect(
      service.computeSybilScore('user-1', {
        authority,
        failClosedOnStale: true,
      }),
    ).rejects.toThrow(StaleFeatureException);
  });
});

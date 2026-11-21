import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CanonicalEvent } from '../v2/events/entities/canonical-event.entity';
import { EventCheckpoint } from '../v2/events/entities/event-checkpoint.entity';
import {
  AccuracyEvent,
  CANONICAL_CLAIM_ACCURACY_SOURCE,
  ClaimAccuracyService,
  projectClaimAccuracy,
} from './claim-accuracy.service';
import { ChainArtifactAuthority } from './sybil-resistance.types';

const SOURCE = CANONICAL_CLAIM_ACCURACY_SOURCE;
const VERIFIER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const VERIFIER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const AUTHOR = '0xcccccccccccccccccccccccccccccccccccccccc';
const OTHER_AUTHOR = '0xdddddddddddddddddddddddddddddddddddddddd';
const WALLETS = [{ address: VERIFIER_A, chain: 'optimism-sepolia' }];

const authority: ChainArtifactAuthority = {
  chainId: SOURCE.chainId,
  releaseId: SOURCE.releaseId,
  artifactHash: SOURCE.artifactHash,
  contractAddress: SOURCE.verificationEngineAddress,
  finalizedThroughBlock: SOURCE.deploymentBlock + 1000,
};

function tx(seed: number): string {
  return `0x${seed.toString(16).padStart(64, '0')}`;
}

function event(
  input: Partial<AccuracyEvent> & { eventName: string; seed: number },
): AccuracyEvent {
  return {
    chainId: SOURCE.chainId,
    contractAddress: SOURCE.verificationEngineAddress,
    artifactVersion: SOURCE.releaseId,
    txHash: tx(input.seed),
    logIndex: input.seed,
    blockNumber: BigInt(SOURCE.deploymentBlock + 10),
    blockTimestamp: new Date('2026-11-01T00:00:00.000Z'),
    actor: null,
    claimId: null,
    payload: {},
    ...input,
  };
}

function submit(
  claimId: string,
  seed: number,
  author: string = AUTHOR,
): AccuracyEvent {
  return event({
    eventName: 'ClaimSubmitted',
    contractAddress: SOURCE.claimRegistryAddress,
    claimId,
    actor: author,
    seed,
  });
}

function settle(
  claimId: string,
  seed: number,
  finalVerdict: unknown,
  blockOffset = 50,
): AccuracyEvent {
  return event({
    eventName: 'VerdictSettled',
    claimId,
    payload: { finalVerdict },
    seed,
    blockNumber: BigInt(SOURCE.deploymentBlock + blockOffset),
  });
}

function record(
  claimId: string,
  seed: number,
  verifier: string,
  verdict: unknown,
  blockOffset = 60,
  extra: Partial<AccuracyEvent> = {},
): AccuracyEvent {
  return event({
    eventName: 'VerificationRecorded',
    claimId,
    actor: verifier,
    payload: { verdict },
    seed,
    blockNumber: BigInt(SOURCE.deploymentBlock + blockOffset),
    ...extra,
  });
}

function project(
  events: AccuracyEvent[],
  wallets = WALLETS,
  overrides: Partial<Parameters<typeof projectClaimAccuracy>[0]> = {},
) {
  return projectClaimAccuracy({
    events,
    wallets,
    authority,
    finalizedThroughBlock: authority.finalizedThroughBlock,
    ...overrides,
  });
}

function chain(events: AccuracyEvent[]) {
  return [
    submit('claim-1', 1),
    settle('claim-1', 2, true),
    record('claim-1', 3, VERIFIER_A, true),
    ...events,
  ];
}

describe('PREWAVE-BE-152 — accuracy from finalized canonical claim history', () => {
  describe('projectClaimAccuracy', () => {
    it('marks accuracy missing when there are no eligible finalized evaluations', () => {
      const result = project([
        submit('claim-1', 1),
        settle('claim-1', 2, true),
      ]);

      expect(result.claimsVotedOn).toBe(0);
      expect(result.claimsCorrect).toBe(0);
      expect(result.provenance.status).toBe('finalized');
      expect(result.provenance.eligibleEvaluationCount).toBe(0);
    });

    it('derives the expected ratio from correct and incorrect finalized evaluations', () => {
      const result = project([
        ...chain([]),
        submit('claim-2', 11, OTHER_AUTHOR),
        settle('claim-2', 12, true),
        record('claim-2', 13, VERIFIER_A, false),
        submit('claim-3', 21, OTHER_AUTHOR),
        settle('claim-3', 22, false),
        record('claim-3', 23, VERIFIER_A, false),
      ]);

      expect(result.claimsVotedOn).toBe(3);
      expect(result.claimsCorrect).toBe(2);
    });

    it('normalizes boolean, numeric and bytes32 canonical verdict encodings', () => {
      const result = project([
        submit('claim-1', 1),
        settle(
          'claim-1',
          2,
          '0x0000000000000000000000000000000000000000000000000000000000000001',
        ),
        record('claim-1', 3, VERIFIER_A, 'true'),
        submit('claim-2', 11, OTHER_AUTHOR),
        settle('claim-2', 12, 0),
        record('claim-2', 13, VERIFIER_A, '0x00'),
      ]);

      expect(result.claimsVotedOn).toBe(2);
      expect(result.claimsCorrect).toBe(2);
    });

    it('does not count pending, unfinalized, reverted or non-canonical events', () => {
      const result = project([
        submit('claim-2', 11, OTHER_AUTHOR),
        settle('claim-2', 12, true, 1100),
        record('claim-2', 13, VERIFIER_A, true, 1110),
        record('claim-3', 21, VERIFIER_A, true, 60),
        event({
          eventName: 'VerificationRecorded',
          seed: 22,
          claimId: 'claim-3',
          actor: VERIFIER_A,
          payload: { verdict: true },
          contractAddress: '0x0000000000000000000000000000000000009999',
        }),
      ]);

      expect(result.claimsVotedOn).toBe(0);
      expect(result.provenance.exclusions.invalidProvenance).toBeGreaterThan(0);
    });

    it('does not count evaluations for claims without a finalized settlement', () => {
      const result = project([
        submit('claim-1', 1),
        record('claim-1', 3, VERIFIER_A, true),
      ]);

      expect(result.claimsVotedOn).toBe(0);
      expect(result.provenance.exclusions.unsettled).toBe(1);
    });

    it('deduplicates identical log positions and excludes conflicting duplicate evaluations', () => {
      const duplicate = record('claim-1', 3, VERIFIER_A, true);
      const result = project(
        chain([duplicate, record('claim-1', 4, VERIFIER_A, false, 70)]),
      );

      expect(result.provenance.exclusions.duplicateEvents).toBe(1);
      expect(result.provenance.exclusions.conflictingEvaluation).toBe(1);
      expect(result.claimsVotedOn).toBe(0);
    });

    it('excludes an unresolved dispute and applies resolved dispute outcomes deterministically', () => {
      const raised = event({
        eventName: 'DisputeRaised',
        seed: 30,
        claimId: 'claim-1',
        blockNumber: BigInt(SOURCE.deploymentBlock + 200),
      });

      const disputed = project(chain([raised]));
      expect(disputed.claimsVotedOn).toBe(0);
      expect(disputed.provenance.exclusions.disputed).toBe(1);

      const overturned = project(
        chain([
          raised,
          event({
            eventName: 'DisputeResolved',
            seed: 31,
            claimId: 'claim-1',
            payload: { outcome: 'overturned' },
            blockNumber: BigInt(SOURCE.deploymentBlock + 210),
          }),
        ]),
      );
      expect(overturned.claimsVotedOn).toBe(1);
      expect(overturned.claimsCorrect).toBe(0);

      const upheld = project(
        chain([
          event({
            eventName: 'DisputeResolved',
            seed: 32,
            claimId: 'claim-1',
            payload: { outcome: 'upheld' },
            blockNumber: BigInt(SOURCE.deploymentBlock + 210),
          }),
        ]),
      );
      expect(upheld.claimsVotedOn).toBe(1);
      expect(upheld.claimsCorrect).toBe(1);
    });

    it('recomputes counts deterministically after a reorg rollback', () => {
      const rolledBack = record('claim-1', 3, VERIFIER_A, true, 60, {
        blockHash: `0x${'ab'.repeat(32)}`,
      });
      const before = project([
        submit('claim-1', 1),
        settle('claim-1', 2, true),
        rolledBack,
      ]);

      expect(before.claimsVotedOn).toBe(1);
      expect(before.claimsCorrect).toBe(1);

      const after = project(
        [submit('claim-1', 1), settle('claim-1', 2, true), rolledBack],
        WALLETS,
        {
          orphanedBlockHashes: [`0x${'AB'.repeat(32)}`],
        },
      );

      expect(after.claimsVotedOn).toBe(0);
      expect(after.provenance.exclusions.reorgedEvents).toBe(1);
    });

    it('aggregates linked wallets without double counting', () => {
      const result = project(
        chain([
          record('claim-1', 4, VERIFIER_B, true),
          record('claim-1', 5, VERIFIER_A.toUpperCase(), true, 80),
        ]),
        [
          { address: VERIFIER_A, chain: 'optimism-sepolia' },
          { address: VERIFIER_B, chain: 'optimism-sepolia' },
          { address: VERIFIER_A.toUpperCase(), chain: 'optimism-sepolia' },
        ],
      );

      expect(result.claimsVotedOn).toBe(2);
      expect(result.claimsCorrect).toBe(2);
    });

    it('does not cross-contaminate identities on unlink, relink or chain changes', () => {
      const events = chain([]);
      const unlinked = project(events, []);
      const wrongChain = project(events, [
        { address: VERIFIER_A, chain: 'optimism' },
      ]);
      const relinked = project(events, [
        { address: VERIFIER_B, chain: 'optimism-sepolia' },
        { address: VERIFIER_A, chain: 'optimism-sepolia' },
      ]);

      expect(unlinked.claimsVotedOn).toBe(0);
      expect(wrongChain.claimsVotedOn).toBe(0);
      expect(wrongChain.provenance.exclusions.crossChainWallet).toBe(1);
      expect(relinked.claimsVotedOn).toBe(1);
    });

    it('excludes abstentions, own claims and unverifiable claim authors', () => {
      const result = project([
        submit('claim-2', 11, OTHER_AUTHOR),
        settle('claim-2', 12, true),
        record('claim-2', 13, VERIFIER_A, 'abstain'),
        submit('claim-3', 14, VERIFIER_A),
        settle('claim-3', 15, true),
        record('claim-3', 16, VERIFIER_A, true),
        record('claim-4', 17, VERIFIER_A, true),
      ]);

      expect(result.claimsVotedOn).toBe(0);
      expect(result.provenance.exclusions.abstention).toBe(1);
      expect(result.provenance.exclusions.ownClaim).toBe(1);
      expect(result.provenance.exclusions.unknownClaimAuthor).toBe(1);
    });
  });

  describe('ClaimAccuracyService', () => {
    let service: ClaimAccuracyService;
    let eventsRepo: any;
    let checkpointsRepo: any;
    let queryBuilder: any;

    const checkpoint = {
      chainId: SOURCE.chainId,
      contractAddress: SOURCE.verificationEngineAddress,
      lastFinalizedBlock: String(SOURCE.deploymentBlock + 1000),
      updatedAt: new Date('2026-11-02T00:00:00.000Z'),
    };

    beforeEach(async () => {
      queryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      eventsRepo = {
        createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      };
      checkpointsRepo = {
        findOne: jest.fn().mockResolvedValue(checkpoint),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ClaimAccuracyService,
          {
            provide: getRepositoryToken(CanonicalEvent),
            useValue: eventsRepo,
          },
          {
            provide: getRepositoryToken(EventCheckpoint),
            useValue: checkpointsRepo,
          },
        ],
      }).compile();
      service = module.get<ClaimAccuracyService>(ClaimAccuracyService);
    });

    it('derives counts from canonical rows bounded by the finalized checkpoint', async () => {
      queryBuilder.getMany.mockResolvedValueOnce([
        submit('claim-1', 1),
        settle('claim-1', 2, true),
        record('claim-1', 3, VERIFIER_A, true),
      ] as unknown as CanonicalEvent[]);

      const result = await service.deriveAccuracy(WALLETS, authority);

      expect(result.claimsVotedOn).toBe(1);
      expect(result.claimsCorrect).toBe(1);
      expect(result.provenance.status).toBe('finalized');
      expect(result.provenance.releaseId).toBe(authority.releaseId);
      expect(result.provenance.finalizedThroughBlock).toBe(
        authority.finalizedThroughBlock,
      );
      expect(checkpointsRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            chainId: SOURCE.chainId,
            contractAddress: SOURCE.verificationEngineAddress,
          },
        }),
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'CAST(e.blockNumber AS NUMERIC) <= :finalizedBlock',
        { finalizedBlock: String(authority.finalizedThroughBlock) },
      );
    });

    it('caps derivation at the checkpoint when authority is ahead', async () => {
      await service.deriveAccuracy(WALLETS, {
        ...authority,
        finalizedThroughBlock: SOURCE.deploymentBlock + 5000,
      });

      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'CAST(e.blockNumber AS NUMERIC) <= :finalizedBlock',
        { finalizedBlock: String(SOURCE.deploymentBlock + 1000) },
      );
    });

    it('uses the canonical binding when no authority is supplied', async () => {
      const result = await service.deriveAccuracy(WALLETS);

      expect(result.provenance.chainId).toBe(SOURCE.chainId);
      expect(result.provenance.releaseId).toBe(SOURCE.releaseId);
      expect(result.observedAt?.toISOString()).toBe(
        checkpoint.updatedAt.toISOString(),
      );
    });

    it('reports unavailable history honestly when the checkpoint is missing', async () => {
      checkpointsRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.deriveAccuracy(WALLETS);

      expect(result.claimsVotedOn).toBe(0);
      expect(result.claimsCorrect).toBe(0);
      expect(result.provenance.status).toBe('unavailable');
      expect(result.provenance.reason).toBe('checkpoint-missing');
      expect(result.provenance.observedAt).toBeNull();
    });

    it('reports unavailable history honestly when reads fail', async () => {
      checkpointsRepo.findOne.mockRejectedValueOnce(new Error('db down'));
      const checkpointFailure = await service.deriveAccuracy(WALLETS);
      expect(checkpointFailure.provenance.reason).toBe(
        'checkpoint-unavailable',
      );

      queryBuilder.getMany.mockRejectedValueOnce(new Error('db down'));
      const historyFailure = await service.deriveAccuracy(WALLETS);
      expect(historyFailure.claimsVotedOn).toBe(0);
      expect(historyFailure.provenance.status).toBe('unavailable');
      expect(historyFailure.provenance.reason).toBe('history-unavailable');
    });

    it('fails closed on a non-canonical authority', async () => {
      const result = await service.deriveAccuracy(WALLETS, {
        ...authority,
        releaseId: 'unauthorized-release',
      });

      expect(result.provenance.status).toBe('unavailable');
      expect(result.provenance.reason).toBe('authority-mismatch');
      expect(eventsRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});

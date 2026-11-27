import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CanonicalEvent } from '../v2/events/entities/canonical-event.entity';
import { EventCheckpoint } from '../v2/events/entities/event-checkpoint.entity';
import {
  AccuracyEvent,
  CANONICAL_CLAIM_ACCURACY_BINDING,
  ClaimAccuracyService,
  projectClaimAccuracy,
} from './claim-accuracy.service';
import { ChainArtifactAuthority } from './sybil-resistance.types';

const BINDING = CANONICAL_CLAIM_ACCURACY_BINDING;

const authority: ChainArtifactAuthority = {
  chainId: BINDING.chainId,
  releaseId: BINDING.releaseId,
  artifactHash: BINDING.artifactHash,
  contractAddress: BINDING.verificationEngineAddress,
  finalizedThroughBlock: BINDING.deploymentBlock + 1000,
};

const verifierA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const verifierB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const claimAuthor = '0xcccccccccccccccccccccccccccccccccccccccc';

function tx(seed: number): string {
  return `0x${seed.toString(16).padStart(64, '0')}`;
}

function event(
  input: Partial<AccuracyEvent> & { eventName: string },
): AccuracyEvent {
  const base: AccuracyEvent = {
    eventName: input.eventName,
    chainId: BINDING.chainId,
    contractAddress: BINDING.verificationEngineAddress,
    artifactVersion: '2.0.0',
    txHash: tx(1),
    logIndex: 0,
    blockNumber: BigInt(BINDING.deploymentBlock + 1),
    blockTimestamp: new Date('2026-11-01T00:00:00.000Z'),
    actor: null,
    claimId: null,
    roundId: null,
    payload: {},
  };
  return { ...base, ...input };
}

function submit(claimId: string, author: string = claimAuthor, seed = 1) {
  return event({
    eventName: 'ClaimSubmitted',
    contractAddress: BINDING.claimRegistryAddress,
    claimId,
    actor: author,
    txHash: tx(seed),
  });
}

function settle(claimId: string, finalVerdict: unknown, seed = 2, block = 100) {
  return event({
    eventName: 'VerdictSettled',
    claimId,
    payload: { finalVerdict },
    txHash: tx(seed),
    blockNumber: BigInt(BINDING.deploymentBlock + block),
  });
}

function verify(
  claimId: string,
  actor: string,
  verdict: unknown,
  seed: number,
  block = 110,
) {
  return event({
    eventName: 'VerificationRecorded',
    claimId,
    actor,
    payload: { verdict },
    txHash: tx(seed),
    logIndex: seed,
    blockNumber: BigInt(BINDING.deploymentBlock + block),
  });
}

function project(
  events: AccuracyEvent[],
  wallets = [{ address: verifierA, chain: 'optimism-sepolia' }],
  overrideAuthority: ChainArtifactAuthority = authority,
) {
  return projectClaimAccuracy({
    events,
    wallets,
    authority: overrideAuthority,
    finalizedThroughBlock: overrideAuthority.finalizedThroughBlock,
    deploymentBlock: BINDING.deploymentBlock,
  });
}

describe('claim accuracy derivation from finalized canonical history', () => {
  describe('projectClaimAccuracy', () => {
    it('marks accuracy missing when there are no eligible finalized evaluations', () => {
      const result = project([submit('claim-1'), settle('claim-1', true)]);

      expect(result.claimsVotedOn).toBe(0);
      expect(result.claimsCorrect).toBe(0);
      expect(result.provenance.status).toBe('finalized');
      expect(result.provenance.eligibleEvaluationCount).toBe(0);
    });

    it('produces the correct ratio from finalized correct and incorrect evaluations', () => {
      const result = project([
        submit('claim-1'),
        settle('claim-1', true),
        verify('claim-1', verifierA, true, 10),
        submit('claim-2', '0xdddddddddddddddddddddddddddddddddddddddd', 20),
        settle('claim-2', true, 21),
        verify('claim-2', verifierA, false, 22),
        submit('claim-3', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 30),
        settle('claim-3', false, 31),
        verify('claim-3', verifierA, false, 32),
      ]);

      expect(result.claimsVotedOn).toBe(3);
      expect(result.claimsCorrect).toBe(2);
      expect(result.provenance.status).toBe('finalized');
    });

    it('normalizes boolean, numeric and bytes32 verdict encodings', () => {
      const result = project([
        submit('claim-1'),
        settle(
          'claim-1',
          '0x0000000000000000000000000000000000000000000000000000000000000001',
        ),
        verify('claim-1', verifierA, 'true', 10),
        submit('claim-2', claimAuthor, 20),
        settle('claim-2', 0, 21),
        verify('claim-2', verifierA, '0x00', 22),
      ]);

      expect(result.claimsVotedOn).toBe(2);
      expect(result.claimsCorrect).toBe(2);
    });

    it('does not count pending, unfinalized, reverted or unsettled outcomes', () => {
      const unfinalizedAuthority = {
        ...authority,
        finalizedThroughBlock: BINDING.deploymentBlock + 100,
      };
      const result = project(
        [
          submit('claim-1'),
          settle('claim-1', true, 2, 200),
          verify('claim-1', verifierA, true, 10, 210),
          submit('claim-2', claimAuthor, 20),
          event({
            eventName: 'ClaimStatusChanged',
            claimId: 'claim-2',
            payload: { newStatus: 5 },
            txHash: tx(21),
          }),
          verify('claim-2', verifierA, true, 22, 210),
        ],
        [{ address: verifierA, chain: 'optimism-sepolia' }],
        unfinalizedAuthority,
      );

      expect(result.claimsVotedOn).toBe(0);
      expect(result.claimsCorrect).toBe(0);
      expect(result.provenance.excluded?.invalidProvenance).toBeGreaterThan(0);
    });

    it('deduplicates identical log positions and conflicting duplicate evaluations', () => {
      const duplicateLog = verify('claim-1', verifierA, true, 10);
      const result = project([
        submit('claim-1'),
        settle('claim-1', true),
        verify('claim-1', verifierA, true, 10),
        duplicateLog,
        verify('claim-1', verifierA, true, 11),
        verify('claim-1', verifierA, false, 12),
      ]);

      expect(result.provenance.excluded?.duplicateEvents).toBe(1);
      expect(result.provenance.excluded?.conflictingDuplicate).toBe(1);
      expect(result.claimsVotedOn).toBe(0);
    });

    it('excludes an unresolved dispute and uses a resolved overturn deterministically', () => {
      const claim = [
        submit('claim-1'),
        settle('claim-1', true),
        verify('claim-1', verifierA, true, 10),
      ];

      const raised = project([
        ...claim,
        event({
          eventName: 'DisputeRaised',
          claimId: 'claim-1',
          txHash: tx(20),
          blockNumber: BigInt(BINDING.deploymentBlock + 150),
        }),
      ]);
      expect(raised.claimsVotedOn).toBe(0);
      expect(raised.provenance.excluded?.disputed).toBe(1);

      const overturned = project([
        ...claim,
        event({
          eventName: 'DisputeRaised',
          claimId: 'claim-1',
          txHash: tx(20),
          blockNumber: BigInt(BINDING.deploymentBlock + 150),
        }),
        event({
          eventName: 'DisputeResolved',
          claimId: 'claim-1',
          payload: { outcome: 'overturned' },
          txHash: tx(21),
          blockNumber: BigInt(BINDING.deploymentBlock + 160),
        }),
      ]);
      expect(overturned.claimsVotedOn).toBe(1);
      expect(overturned.claimsCorrect).toBe(0);

      const upheld = project([
        ...claim,
        event({
          eventName: 'DisputeResolved',
          claimId: 'claim-1',
          payload: { outcome: 'upheld' },
          txHash: tx(22),
          blockNumber: BigInt(BINDING.deploymentBlock + 160),
        }),
      ]);
      expect(upheld.claimsVotedOn).toBe(1);
      expect(upheld.claimsCorrect).toBe(1);
    });

    it('resolves dispute events attached only by roundId', () => {
      const result = project([
        submit('claim-1'),
        event({
          eventName: 'VerificationRoundOpened',
          claimId: 'claim-1',
          roundId: 'round-1',
          txHash: tx(5),
        }),
        settle('claim-1', true),
        verify('claim-1', verifierA, true, 10),
        event({
          eventName: 'DisputeRaised',
          roundId: 'round-1',
          txHash: tx(20),
          blockNumber: BigInt(BINDING.deploymentBlock + 150),
        }),
      ]);

      expect(result.claimsVotedOn).toBe(0);
      expect(result.provenance.excluded?.disputed).toBe(1);
    });

    it('excludes abstentions, own claims, unknown authors and unknown outcomes', () => {
      const result = project([
        submit('claim-1'),
        settle('claim-1', true),
        verify('claim-1', verifierA, 'abstain', 10),
        submit('claim-2', verifierA, 20),
        settle('claim-2', true, 21),
        verify('claim-2', verifierA, true, 22),
        settle('claim-3', true, 31),
        verify('claim-3', verifierA, true, 32),
        submit('claim-4', claimAuthor, 40),
        settle('claim-4', 'unknown', 41),
        verify('claim-4', verifierA, true, 42),
      ]);

      expect(result.claimsVotedOn).toBe(0);
      expect(result.provenance.excluded?.abstention).toBe(1);
      expect(result.provenance.excluded?.ownClaim).toBe(1);
      expect(result.provenance.excluded?.unknownOutcome).toBe(1);
      expect(result.provenance.excluded?.unverifiedClaimAuthor).toBe(1);
    });

    it('aggregates linked wallets without double counting', () => {
      const result = project(
        [
          submit('claim-1'),
          settle('claim-1', true),
          verify('claim-1', verifierA, true, 10),
          verify('claim-1', verifierB, true, 11),
        ],
        [
          { address: verifierA, chain: 'optimism-sepolia' },
          { address: verifierB, chain: 'optimism-sepolia' },
          { address: verifierA.toUpperCase(), chain: 'optimism-sepolia' },
        ],
      );

      expect(result.claimsVotedOn).toBe(2);
      expect(result.claimsCorrect).toBe(2);
    });

    it('does not cross-contaminate identities on unlink, relink or chain changes', () => {
      const result = project(
        [
          submit('claim-1'),
          settle('claim-1', true),
          verify('claim-1', verifierA, true, 10),
          verify('claim-1', verifierB, true, 11),
        ],
        [
          { address: verifierA, chain: 'optimism' },
          {
            address: '0x1111111111111111111111111111111111111111',
            chain: 'optimism-sepolia',
          },
        ],
      );

      expect(result.claimsVotedOn).toBe(0);
      expect(result.provenance.excluded?.crossChainWallet).toBe(1);
    });

    it('derives different counts deterministically after a reorg rollback', () => {
      const before = project([
        submit('claim-1'),
        settle('claim-1', true),
        verify('claim-1', verifierA, true, 10),
        submit('claim-2', claimAuthor, 29),
        event({
          eventName: 'VerdictSettled',
          claimId: 'claim-2',
          payload: { finalVerdict: true },
          txHash: tx(30),
          blockNumber: BigInt(BINDING.deploymentBlock + 900),
        }),
        verify('claim-2', verifierA, false, 31, 910),
      ]);

      expect(before.claimsVotedOn).toBe(2);
      expect(before.claimsCorrect).toBe(1);

      const rolledBack = projectClaimAccuracy({
        events: [
          submit('claim-1'),
          settle('claim-1', true),
          verify('claim-1', verifierA, true, 10),
        ],
        wallets: [{ address: verifierA, chain: 'optimism-sepolia' }],
        authority: {
          ...authority,
          finalizedThroughBlock: BINDING.deploymentBlock + 500,
        },
        finalizedThroughBlock: BINDING.deploymentBlock + 500,
        deploymentBlock: BINDING.deploymentBlock,
      });

      expect(rolledBack.claimsVotedOn).toBe(1);
      expect(rolledBack.claimsCorrect).toBe(1);
    });

    it('reports observation time from the counted canonical events', () => {
      const observedAt = new Date('2026-11-15T12:00:00.000Z');
      const result = project([
        submit('claim-1'),
        settle('claim-1', true),
        event({
          ...verify('claim-1', verifierA, true, 10),
          blockTimestamp: observedAt,
        }),
      ]);

      expect(result.observedAt).toEqual(observedAt);
      expect(result.provenance.observedAt).toBe(observedAt.toISOString());
    });
  });

  describe('ClaimAccuracyService', () => {
    let service: ClaimAccuracyService;
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
          lastFinalizedBlock: String(BINDING.deploymentBlock + 1000),
          updatedAt: new Date('2026-11-20T00:00:00.000Z'),
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ClaimAccuracyService,
          { provide: getRepositoryToken(CanonicalEvent), useValue: eventsRepo },
          {
            provide: getRepositoryToken(EventCheckpoint),
            useValue: checkpointsRepo,
          },
        ],
      }).compile();

      service = module.get(ClaimAccuracyService);
    });

    it('queries finalized canonical history and returns derived counts', async () => {
      qb.getMany.mockResolvedValue([
        submit('claim-1') as any,
        settle('claim-1', true) as any,
        verify('claim-1', verifierA, true, 10) as any,
      ]);

      const result = await service.deriveAccuracy(
        [{ address: verifierA, chain: 'optimism-sepolia' }],
        authority,
      );

      expect(result.claimsVotedOn).toBe(1);
      expect(result.claimsCorrect).toBe(1);
      expect(qb.where).toHaveBeenCalledWith('e.chainId = :chainId', {
        chainId: authority.chainId,
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        'CAST(e.blockNumber AS NUMERIC) <= :finalizedBlock',
        { finalizedBlock: String(authority.finalizedThroughBlock) },
      );
    });

    it('resolves the default authority from the pinned release manifest checkpoint', async () => {
      qb.getMany.mockResolvedValue([
        submit('claim-1') as any,
        settle('claim-1', false) as any,
        verify('claim-1', verifierA, false, 10) as any,
      ]);

      const result = await service.deriveAccuracy([
        { address: verifierA, chain: 'optimism-sepolia' },
      ]);

      expect(checkpointsRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            chainId: BINDING.chainId,
            contractAddress: BINDING.verificationEngineAddress,
          },
        }),
      );
      expect(result.claimsVotedOn).toBe(1);
      expect(result.claimsCorrect).toBe(1);
      expect(result.provenance.releaseId).toBe(BINDING.releaseId);
    });

    it('surfaces unavailable history honestly when checkpoint or events cannot be read', async () => {
      checkpointsRepo.findOne.mockResolvedValueOnce(null);
      const withoutCheckpoint = await service.deriveAccuracy([]);
      expect(withoutCheckpoint.provenance.status).toBe('unavailable');
      expect(withoutCheckpoint.provenance.reason).toBe('checkpoint-missing');

      qb.getMany.mockRejectedValueOnce(new Error('db down'));
      const withoutHistory = await service.deriveAccuracy([], authority);
      expect(withoutHistory.claimsVotedOn).toBe(0);
      expect(withoutHistory.provenance.status).toBe('unavailable');
      expect(withoutHistory.provenance.reason).toBe('history-unavailable');
    });

    it('caps derivation at the checkpoint even when authority is ahead', async () => {
      qb.getMany.mockResolvedValue([]);
      const result = await service.deriveAccuracy([], {
        ...authority,
        finalizedThroughBlock: BINDING.deploymentBlock + 5000,
      });

      expect(qb.andWhere).toHaveBeenCalledWith(
        'CAST(e.blockNumber AS NUMERIC) <= :finalizedBlock',
        { finalizedBlock: String(BINDING.deploymentBlock + 1000) },
      );
      expect(result.provenance.finalizedThroughBlock).toBe(
        BINDING.deploymentBlock + 1000,
      );
    });
  });
});

import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  DisputeService,
  CreateDisputeCommand,
  ProjectOutcomeCommand,
} from './dispute.service';
import { DisputeEvidenceService } from './canonical-dispute-evidence.service';
import { CanonicalEvent } from '../v2/events/entities/canonical-event.entity';
import {
  Dispute,
  DisputeStatus,
  DisputeTrigger,
  DisputeOutcome,
  DisputeRecordKind,
  DisputeDataState,
} from './entities/dispute.entity';

const PRINCIPAL = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DEPLOYMENT = '0xcccccccccccccccccccccccccccccccccccccccc';
const CLAIM = '0x' + 'a'.repeat(64);
const ROUND = '0x' + 'b'.repeat(64);
const TX = '0x' + 'd'.repeat(64);
const TERMINAL_TX = '0x' + 'f'.repeat(64);
const REF = { chainId: 10, txHash: TX, logIndex: 1 };
const TERMINAL_REF = { chainId: 10, txHash: TERMINAL_TX, logIndex: 3 };

const RAISE_EVIDENCE = {
  chainId: 10,
  deploymentAddress: DEPLOYMENT,
  artifactVersion: 'dispute-v1',
  blockNumber: '100',
  txHash: TX,
  logIndex: 1,
  occurredAt: new Date('2026-01-01T00:00:00Z'),
  claimId: CLAIM,
  roundId: ROUND,
  challenger: PRINCIPAL,
  bondAsset: DEPLOYMENT,
  bondAmount: '1000',
  trigger: DisputeTrigger.LOW_CONFIDENCE,
  reportedConfidence: 0.4,
};

const TERMINAL_EVIDENCE = {
  chainId: 10,
  deploymentAddress: DEPLOYMENT,
  artifactVersion: 'dispute-v1',
  blockNumber: '200',
  txHash: TERMINAL_TX,
  logIndex: 3,
  occurredAt: new Date('2026-01-02T00:00:00Z'),
  claimId: CLAIM,
  roundId: ROUND,
  terminalEventName: 'DisputeResolved' as const,
  outcome: DisputeOutcome.OVERTURNED,
  finalConfidence: 0.85,
};

const RAISE_METADATA = {
  chainId: 10,
  deploymentAddress: DEPLOYMENT,
  artifactVersion: 'dispute-v1',
  txHash: TX,
  logIndex: 1,
  blockNumber: '100',
  claimId: CLAIM,
  roundId: ROUND,
};

function canonicalDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: 'dispute-1',
    claimId: CLAIM,
    trigger: DisputeTrigger.LOW_CONFIDENCE,
    originalConfidence: 0.4,
    initiatorId: PRINCIPAL,
    status: DisputeStatus.OPEN,
    outcome: null,
    finalConfidence: null,
    resolvedAt: null,
    recordKind: DisputeRecordKind.CANONICAL_PROJECTION,
    dataState: DisputeDataState.FINALIZED,
    chainId: 10,
    deploymentAddress: DEPLOYMENT,
    artifactVersion: 'dispute-v1',
    canonicalClaimId: CLAIM,
    originalRoundId: ROUND,
    eventTxHash: TX,
    eventLogIndex: 1,
    eventBlockNumber: '100',
    metadata: { canonicalRaise: RAISE_METADATA },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Dispute;
}

describe('DisputeService — canonical outcome projections', () => {
  let service: DisputeService;
  let stored: Dispute | null;
  let disputes: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let events: { find: jest.Mock };
  let evidence: {
    assertDisputeRaised: jest.Mock;
    assertDisputeTerminal: jest.Mock;
  };
  let staleRecords: Dispute[];

  beforeEach(async () => {
    stored = null;
    staleRecords = [];

    disputes = {
      create: jest.fn((attrs) => ({ ...attrs })),
      save: jest.fn(async (entity) => {
        if (!entity.id) entity.id = 'dispute-1';
        stored = entity;
        return entity;
      }),
      findOne: jest.fn(async (options: any) => {
        if (options?.where?.id) {
          return stored?.id === options.where.id ? stored : null;
        }
        if (options?.where?.eventTxHash) {
          return stored?.eventTxHash === options.where.eventTxHash
            ? stored
            : null;
        }
        return null;
      }),
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          where: () => qb,
          andWhere: () => qb,
          orderBy: () => qb,
          skip: () => qb,
          take: () => qb,
          getOne: async () => null,
          getMany: async () => staleRecords,
          getManyAndCount: async () => [[], 0],
        };
        return qb;
      }),
    };
    events = { find: jest.fn().mockResolvedValue([]) };
    evidence = {
      assertDisputeRaised: jest.fn().mockResolvedValue(RAISE_EVIDENCE),
      assertDisputeTerminal: jest.fn().mockResolvedValue(TERMINAL_EVIDENCE),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputeService,
        { provide: getRepositoryToken(Dispute), useValue: disputes },
        { provide: getRepositoryToken(CanonicalEvent), useValue: events },
        { provide: DisputeEvidenceService, useValue: evidence },
      ],
    }).compile();

    service = module.get(DisputeService);
  });

  const createCommand = (
    overrides: Partial<CreateDisputeCommand> = {},
  ): CreateDisputeCommand => ({
    claimId: CLAIM,
    principal: PRINCIPAL,
    ...overrides,
  });

  const projectCommand = (
    overrides: Partial<ProjectOutcomeCommand> = {},
  ): ProjectOutcomeCommand => ({
    disputeId: 'dispute-1',
    canonicalEvent: TERMINAL_REF,
    ...overrides,
  });

  it('derives the initiator from the verified principal and marks workflow rows non-authoritative', async () => {
    const result = await service.createDispute(
      createCommand({ claimId: 'legacy-claim', principal: PRINCIPAL } as any),
    );
    expect(result.initiatorId).toBe(PRINCIPAL);
    expect(result.claimId).toBe('legacy-claim');
    expect(result.trigger).toBe(DisputeTrigger.MANUAL);
    expect(result.originalConfidence).toBe(0);
    expect(result.recordKind).toBe(DisputeRecordKind.LEGACY_WORKFLOW);
    expect(result.dataState).toBe(DisputeDataState.LOCAL_WORKFLOW);
    expect(result.metadata.nonAuthoritative).toBe(true);
  });

  it('rejects an invalid principal instead of trusting a body identity', async () => {
    await expect(
      service.createDispute(createCommand({ principal: OTHER + '00' })),
    ).rejects.toThrow('INVALID_VERIFIED_PRINCIPAL');
  });

  it('projects a canonical raise with exact provenance and a derived actor', async () => {
    const result = await service.createDispute(
      createCommand({ canonicalEvent: REF, claimId: CLAIM }),
    );
    expect(evidence.assertDisputeRaised).toHaveBeenCalledWith(REF, PRINCIPAL);
    expect(result).toMatchObject({
      initiatorId: PRINCIPAL,
      claimId: CLAIM,
      trigger: DisputeTrigger.LOW_CONFIDENCE,
      originalConfidence: 0.4,
      recordKind: DisputeRecordKind.CANONICAL_PROJECTION,
      dataState: DisputeDataState.FINALIZED,
      chainId: 10,
      deploymentAddress: DEPLOYMENT,
      artifactVersion: 'dispute-v1',
      eventTxHash: TX,
      eventLogIndex: 1,
      eventBlockNumber: '100',
      canonicalClaimId: CLAIM,
      originalRoundId: ROUND,
    });
  });

  it('rejects a claim id that disagrees with the canonical raise', async () => {
    await expect(
      service.createDispute(
        createCommand({ canonicalEvent: REF, claimId: 'other-claim' }),
      ),
    ).rejects.toThrow('CLAIM_ID_MISMATCH');
  });

  it('writes terminal fields and full provenance only from canonical evidence', async () => {
    stored = canonicalDispute();
    const result = await service.projectOutcome(projectCommand());
    expect(evidence.assertDisputeTerminal).toHaveBeenCalledWith(
      TERMINAL_REF,
      CLAIM,
      ROUND,
    );
    expect(result).toMatchObject({
      status: DisputeStatus.RESOLVED,
      outcome: DisputeOutcome.OVERTURNED,
      finalConfidence: 0.85,
      recordKind: DisputeRecordKind.CANONICAL_PROJECTION,
      dataState: DisputeDataState.FINALIZED,
      chainId: 10,
      deploymentAddress: DEPLOYMENT,
      artifactVersion: 'dispute-v1',
      eventTxHash: TERMINAL_TX,
      eventLogIndex: 3,
      eventBlockNumber: '200',
    });
    expect(result.resolvedAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(result.metadata.canonicalTerminal).toMatchObject({
      eventName: 'DisputeResolved',
      txHash: TERMINAL_TX,
      blockNumber: '200',
    });
  });

  it('refuses to project onto a local workflow record', async () => {
    stored = canonicalDispute({
      recordKind: DisputeRecordKind.LEGACY_WORKFLOW,
      dataState: DisputeDataState.LOCAL_WORKFLOW,
      canonicalClaimId: null,
      originalRoundId: null,
    });
    await expect(service.projectOutcome(projectCommand())).rejects.toThrow(
      'CANONICAL_DISPUTE_REQUIRED',
    );
    expect(evidence.assertDisputeTerminal).not.toHaveBeenCalled();
  });

  it('propagates fail-closed evidence errors (wrong chain / unfinalized / reorged)', async () => {
    stored = canonicalDispute();
    evidence.assertDisputeTerminal.mockRejectedValue(
      new BadRequestException('EVENT_NOT_FINALIZED'),
    );
    await expect(service.projectOutcome(projectCommand())).rejects.toThrow(
      'EVENT_NOT_FINALIZED',
    );
    expect(stored.status).toBe(DisputeStatus.OPEN);
    expect(stored.outcome).toBeNull();
  });

  it('handles duplicate canonical logs deterministically', async () => {
    stored = canonicalDispute();
    disputes.findOne.mockImplementation(async (options: any) => {
      if (options?.where?.id) return stored;
      if (options?.where?.eventTxHash === TERMINAL_TX) {
        return { id: 'other-dispute' } as Dispute;
      }
      return null;
    });
    await expect(service.projectOutcome(projectCommand())).rejects.toThrow(
      ConflictException,
    );

    disputes.findOne.mockImplementation(async (options: any) => {
      if (options?.where?.id) return stored;
      if (options?.where?.eventTxHash === TERMINAL_TX) return stored;
      return null;
    });
    const replayed = await service.projectOutcome(projectCommand());
    expect(replayed.id).toBe('dispute-1');
  });

  it('moderator triage never marks a dispute resolved, rejected or expired', async () => {
    stored = canonicalDispute({
      status: DisputeStatus.REVIEWING,
      outcome: null,
      finalConfidence: null,
      resolvedAt: null,
    });
    const before = { ...stored };

    const result = await service.recordTriage({
      disputeId: 'dispute-1',
      principal: PRINCIPAL,
      reason: 'needs evidence',
      note: 'waiting for finality',
    });

    expect(result.status).toBe(before.status);
    expect(result.outcome).toBe(before.outcome);
    expect(result.finalConfidence).toBe(before.finalConfidence);
    expect(result.resolvedAt).toBe(before.resolvedAt);
    expect(result.metadata.reviewTriage).toEqual([
      expect.objectContaining({
        by: PRINCIPAL,
        reason: 'needs evidence',
        note: 'waiting for finality',
        nonAuthoritative: true,
      }),
    ]);
  });

  it('clears terminal state above a reorged head and demotes a reorged raise', async () => {
    stored = canonicalDispute({
      status: DisputeStatus.RESOLVED,
      outcome: DisputeOutcome.OVERTURNED,
      finalConfidence: 0.85,
      resolvedAt: new Date(),
      eventTxHash: TERMINAL_TX,
      eventLogIndex: 3,
      eventBlockNumber: '200',
      metadata: {
        canonicalRaise: RAISE_METADATA,
        canonicalTerminal: { txHash: TERMINAL_TX, blockNumber: '200' },
      },
    });
    staleRecords = [stored];

    const result = await service.reconcileReorg(10, 150n);
    expect(result).toEqual({ terminalCleared: 1, disputesDemoted: 0 });
    expect(stored.status).toBe(DisputeStatus.OPEN);
    expect(stored.outcome).toBeNull();
    expect(stored.finalConfidence).toBeNull();
    expect(stored.resolvedAt).toBeNull();
    expect(stored.eventTxHash).toBe(TX);
    expect(stored.metadata.canonicalTerminal).toBeUndefined();

    stored.recordKind = DisputeRecordKind.CANONICAL_PROJECTION;
    stored.eventBlockNumber = '100';
    stored.metadata = { canonicalRaise: RAISE_METADATA };
    staleRecords = [stored];
    const demoted = await service.reconcileReorg(10, 50n);
    expect(demoted.disputesDemoted).toBe(1);
    expect(stored.recordKind).toBe(DisputeRecordKind.LEGACY_WORKFLOW);
    expect(stored.dataState).toBe(DisputeDataState.LOCAL_WORKFLOW);
    expect(stored.canonicalClaimId).toBeNull();
  });

  it('replays the newest finalized terminal event and clears it when none qualifies', async () => {
    stored = canonicalDispute({
      status: DisputeStatus.OPEN,
      outcome: null,
      finalConfidence: null,
      resolvedAt: null,
    });
    events.find.mockResolvedValue([
      {
        chainId: 10,
        txHash: TERMINAL_TX,
        logIndex: 3,
        claimId: CLAIM,
        roundId: ROUND,
      } as CanonicalEvent,
    ]);

    const rebuilt = await service.replayProjection('dispute-1');
    expect(rebuilt.status).toBe(DisputeStatus.RESOLVED);
    expect(rebuilt.outcome).toBe(DisputeOutcome.OVERTURNED);
    expect(rebuilt.eventTxHash).toBe(TERMINAL_TX);

    stored.status = DisputeStatus.RESOLVED;
    stored.outcome = DisputeOutcome.OVERTURNED;
    stored.eventTxHash = TERMINAL_TX;
    evidence.assertDisputeTerminal.mockRejectedValue(
      new BadRequestException('EVENT_NOT_FINALIZED'),
    );
    const cleared = await service.replayProjection('dispute-1');
    expect(cleared.status).toBe(DisputeStatus.OPEN);
    expect(cleared.outcome).toBeNull();
    expect(cleared.eventTxHash).toBe(TX);
  });
});

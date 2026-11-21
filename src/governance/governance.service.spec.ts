import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { GovernanceService } from './governance.service';
import { GovernanceCache } from './governance.cache';
import {
  GovernanceEvidenceService,
  CanonicalVoteEvidence,
} from './canonical-governance-evidence.service';
import {
  Proposal,
  ProposalStatus,
  ProposalCategory,
  Vote,
  GovernanceRecordKind,
  GovernanceDataState,
  VoteSupportMode,
} from './entities/proposal.entity';

const PRINCIPAL = '0x1111111111111111111111111111111111111111';
const CANONICAL_EVENT = {
  chainId: 10,
  txHash: '0x' + 'a'.repeat(64),
  logIndex: 1,
};

const voteEvidence = (
  overrides: Partial<CanonicalVoteEvidence> = {},
): CanonicalVoteEvidence => ({
  chainId: 10,
  governorAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
  proposalId: '42',
  voter: PRINCIPAL,
  support: true,
  supportMode: 'FOR',
  weight: '1000000000000000000',
  artifactVersion: 'governor-v1',
  blockNumber: '100',
  txHash: CANONICAL_EVENT.txHash,
  logIndex: 1,
  ...overrides,
});

describe('GovernanceService — verified identity & canonical projections', () => {
  let service: GovernanceService;
  let proposalRepo: jest.Mocked<Repository<Proposal>>;
  let voteRepo: jest.Mocked<Repository<Vote>>;
  let cache: jest.Mocked<GovernanceCache>;
  let evidence: jest.Mocked<GovernanceEvidenceService>;

  let storedVotes: Vote[];

  const canonicalProposal = (overrides: Partial<Proposal> = {}) =>
    ({
      id: 'prop-1',
      title: 'Canonical',
      description: 'desc',
      proposer: PRINCIPAL,
      category: ProposalCategory.GOVERNANCE,
      status: ProposalStatus.ACTIVE,
      recordKind: GovernanceRecordKind.CANONICAL,
      dataState: GovernanceDataState.FINALIZED,
      canonicalProposalId: '42',
      chainId: 10,
      governorAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      blockNumber: '90',
      creationBlockNumber: '90',
      totalVotes: 0,
      votesFor: 0,
      votesAgainst: 0,
      voteWeightFor: '0',
      voteWeightAgainst: '0',
      voteWeightAbstain: '0',
      ...overrides,
    }) as Proposal;

  beforeEach(async () => {
    storedVotes = [];

    const mockProposalRepo = {
      findOneBy: jest.fn().mockResolvedValue(canonicalProposal()),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation((value) => value),
      save: jest.fn().mockImplementation(async (value) => value),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
      delete: jest.fn(),
    };

    const mockVoteRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockImplementation(async () => storedVotes),
      create: jest.fn().mockImplementation((value) => value),
      save: jest.fn().mockImplementation(async (value) => {
        storedVotes.push(value as Vote);
        return value;
      }),
      delete: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const mockCache = {
      getProposal: jest.fn().mockResolvedValue(null),
      setProposal: jest.fn(),
      getActiveProposals: jest.fn().mockResolvedValue(null),
      setActiveProposals: jest.fn(),
      getStats: jest.fn().mockResolvedValue(null),
      setStats: jest.fn(),
      getVotes: jest.fn().mockResolvedValue(null),
      setVotes: jest.fn(),
      invalidateProposal: jest.fn(),
      invalidateAll: jest.fn(),
    };

    const mockEvidence = {
      assertProposalCreated: jest.fn().mockResolvedValue({
        chainId: 10,
        governorAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
        proposalId: '42',
        proposer: PRINCIPAL,
        artifactVersion: 'governor-v1',
        blockNumber: '90',
        txHash: CANONICAL_EVENT.txHash,
        logIndex: 1,
      }),
      assertVoteCast: jest.fn().mockImplementation(async () => voteEvidence()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GovernanceService,
        { provide: getRepositoryToken(Proposal), useValue: mockProposalRepo },
        { provide: getRepositoryToken(Vote), useValue: mockVoteRepo },
        { provide: GovernanceCache, useValue: mockCache },
        { provide: GovernanceEvidenceService, useValue: mockEvidence },
      ],
    }).compile();

    service = module.get(GovernanceService);
    proposalRepo = module.get(getRepositoryToken(Proposal));
    voteRepo = module.get(getRepositoryToken(Vote));
    cache = module.get(GovernanceCache);
    evidence = module.get(GovernanceEvidenceService);
  });

  // ── Proposals ─────────────────────────────────────────────────────────────

  it('creates an explicitly labelled off-chain draft by default', async () => {
    const result = await service.create({
      title: 'Draft',
      description: 'desc',
      proposer: '0x' + PRINCIPAL.slice(2).toUpperCase(),
      metadata: { note: 'local only' },
    });

    expect(result.recordKind).toBe(GovernanceRecordKind.OFFCHAIN_DRAFT);
    expect(result.dataState).toBe(GovernanceDataState.DRAFT);
    expect(result.status).toBe(ProposalStatus.PENDING);
    expect(result.blockchainTxHash).toBeNull();
    expect(result.proposer).toBe(PRINCIPAL);
    expect(evidence.assertProposalCreated).not.toHaveBeenCalled();
    expect(cache.invalidateAll).toHaveBeenCalled();
  });

  it('projects a canonical proposal only from validated evidence', async () => {
    const result = await service.create({
      title: 'On-chain',
      description: 'desc',
      proposer: PRINCIPAL,
      canonicalEvent: CANONICAL_EVENT,
    });

    expect(evidence.assertProposalCreated).toHaveBeenCalledWith(
      CANONICAL_EVENT,
      PRINCIPAL,
    );
    expect(result.recordKind).toBe(GovernanceRecordKind.CANONICAL);
    expect(result.dataState).toBe(GovernanceDataState.FINALIZED);
    expect(result.canonicalProposalId).toBe('42');
    expect(result.blockchainTxHash).toBe(CANONICAL_EVENT.txHash);
  });

  it('rejects an unvalidated principal and empty title', async () => {
    await expect(
      service.create({ title: 'x', description: 'y', proposer: '0x123' }),
    ).rejects.toThrow('INVALID_VERIFIED_PRINCIPAL');
    await expect(
      service.create({ title: '', description: 'y', proposer: PRINCIPAL }),
    ).rejects.toThrow('Proposal title is required');
  });

  it('never activates or executes an off-chain draft as protocol state', async () => {
    proposalRepo.findOneBy.mockResolvedValue(
      canonicalProposal({
        recordKind: GovernanceRecordKind.OFFCHAIN_DRAFT,
        dataState: GovernanceDataState.DRAFT,
      }),
    );

    await expect(service.activate('prop-1')).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.execute('prop-1')).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.castVote('prop-1', PRINCIPAL, CANONICAL_EVENT),
    ).rejects.toThrow(BadRequestException);
  });

  // ── Voting ────────────────────────────────────────────────────────────────

  it('records a vote only from canonical evidence and ignores client weight', async () => {
    const result = await service.castVote(
      'prop-1',
      PRINCIPAL,
      CANONICAL_EVENT,
      { clientWeight: 999999 },
    );

    expect(evidence.assertVoteCast).toHaveBeenCalledWith(
      CANONICAL_EVENT,
      PRINCIPAL,
      '42',
    );
    expect(result).toMatchObject({
      voter: PRINCIPAL,
      support: true,
      supportMode: VoteSupportMode.FOR,
      weight: '1000000000000000000',
      chainId: 10,
      txHash: CANONICAL_EVENT.txHash,
      dataState: GovernanceDataState.FINALIZED,
    });
    expect(result.metadata).toEqual({ clientWeight: 999999 });
  });

  it('rejects a vote without canonical evidence', async () => {
    await expect(
      service.castVote('prop-1', PRINCIPAL, undefined as any),
    ).rejects.toThrow('CANONICAL_EVENT_REQUIRED');
    expect(voteRepo.save).not.toHaveBeenCalled();
  });

  it('rejects duplicate canonical identity, not just duplicate address strings', async () => {
    voteRepo.findOne.mockResolvedValueOnce(voteEvidence() as any);

    await expect(
      service.castVote('prop-1', PRINCIPAL, CANONICAL_EVENT),
    ).rejects.toThrow(ConflictException);
    expect(voteRepo.save).not.toHaveBeenCalled();
  });

  it('derives totals from canonical vote rows and rebuilds identically', async () => {
    await service.castVote('prop-1', PRINCIPAL, CANONICAL_EVENT);
    evidence.assertVoteCast.mockResolvedValueOnce(
      voteEvidence({
        txHash: '0x' + 'b'.repeat(64),
        logIndex: 2,
        support: false,
        supportMode: VoteSupportMode.AGAINST,
        weight: '7',
      }),
    );
    await service.castVote('prop-1', PRINCIPAL, {
      ...CANONICAL_EVENT,
      txHash: '0x' + 'b'.repeat(64),
      logIndex: 2,
    });

    const first = await service.rebuildProposalTotals('prop-1');
    const second = await service.rebuildProposalTotals('prop-1');

    expect(first.totalVotes).toBe(2);
    expect(first.votesFor).toBe(1);
    expect(first.votesAgainst).toBe(1);
    expect(first.voteWeightFor).toBe('1000000000000000000');
    expect(first.voteWeightAgainst).toBe('7');
    expect(second).toEqual(first);
  });

  // ── Reorg reconciliation ─────────────────────────────────────────────────

  it('removes reorged projections and demotes their proposal deterministically', async () => {
    const staleVote = {
      ...voteEvidence({ blockNumber: '150' }),
      id: 'vote-stale',
    } as Vote;
    const voteQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([staleVote]),
    };
    const proposalQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest
        .fn()
        .mockResolvedValue([canonicalProposal({ creationBlockNumber: '150' })]),
    };
    voteRepo.createQueryBuilder.mockReturnValue(voteQb as any);
    proposalRepo.createQueryBuilder.mockReturnValue(proposalQb as any);

    const result = await service.reconcileReorg(10, 149n);

    expect(result).toEqual({ votesRemoved: 1, proposalsDemoted: 1 });
    expect(voteRepo.delete).toHaveBeenCalledWith({ id: staleVote.id });
    expect(cache.invalidateAll).toHaveBeenCalled();
    expect(storedVotes).toHaveLength(0);
  });

  it('findOne returns null when the repository has no row', async () => {
    proposalRepo.findOneBy.mockResolvedValue(null);
    expect(await service.findOne('missing')).toBeNull();
  });
});

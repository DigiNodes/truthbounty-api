import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GovernanceService } from './governance.service';
import { GovernanceCache } from './governance.cache';
import { Proposal, ProposalStatus, ProposalCategory, Vote } from './entities/proposal.entity';

describe('GovernanceService', () => {
  let service: GovernanceService;
  let proposalRepo: jest.Mocked<Repository<Proposal>>;
  let voteRepo: jest.Mocked<Repository<Vote>>;
  let cache: jest.Mocked<GovernanceCache>;

  beforeEach(async () => {
    const mockProposalRepo = {
      findOneBy: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const mockVoteRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GovernanceService,
        { provide: getRepositoryToken(Proposal), useValue: mockProposalRepo },
        { provide: getRepositoryToken(Vote), useValue: mockVoteRepo },
        { provide: GovernanceCache, useValue: mockCache },
      ],
    }).compile();

    service = module.get<GovernanceService>(GovernanceService);
    proposalRepo = module.get(getRepositoryToken(Proposal));
    voteRepo = module.get(getRepositoryToken(Vote));
    cache = module.get(GovernanceCache);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findOne', () => {
    it('should return a proposal by id', async () => {
      const mockProposal = { id: '1', title: 'Test' } as Proposal;
      proposalRepo.findOneBy.mockResolvedValue(mockProposal);

      const result = await service.findOne('1');
      expect(result).toEqual(mockProposal);
      expect(cache.setProposal).toHaveBeenCalledWith('1', mockProposal);
    });

    it('should return null if proposal not found', async () => {
      proposalRepo.findOneBy.mockResolvedValue(null);

      const result = await service.findOne('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('should create a proposal', async () => {
      const mockProposal = {
        id: '1',
        title: 'Test Proposal',
        description: 'Test description',
        proposer: '0x123',
        category: ProposalCategory.PROTOCOL_UPGRADE,
        status: ProposalStatus.PENDING,
        metadata: {},
      } as Proposal;
      proposalRepo.create.mockReturnValue(mockProposal);
      proposalRepo.save.mockResolvedValue(mockProposal);

      const result = await service.create({
        title: 'Test Proposal',
        description: 'Test description',
        proposer: '0x123',
      });

      expect(result).toEqual(mockProposal);
      expect(cache.invalidateAll).toHaveBeenCalled();
    });

    it('should throw on empty title', async () => {
      await expect(
        service.create({ title: '', description: 'desc', proposer: '0x123' }),
      ).rejects.toThrow('Proposal title is required');
    });
  });

  describe('castVote', () => {
    it('should cast a vote on an active proposal', async () => {
      const mockProposal = {
        id: '1',
        status: ProposalStatus.ACTIVE,
        totalVotes: 0,
        votesFor: 0,
        votesAgainst: 0,
      } as Proposal;
      proposalRepo.findOneBy.mockResolvedValue(mockProposal);
      voteRepo.findOne.mockResolvedValue(null);
      voteRepo.save.mockResolvedValue({} as Vote);
      proposalRepo.save.mockResolvedValue(mockProposal);

      const result = await service.castVote('1', '0x123', true);
      expect(voteRepo.save).toHaveBeenCalled();
      expect(mockProposal.totalVotes).toBe(1);
      expect(mockProposal.votesFor).toBe(1);
    });

    it('should throw on duplicate vote', async () => {
      const mockProposal = {
        id: '1',
        status: ProposalStatus.ACTIVE,
      } as Proposal;
      proposalRepo.findOneBy.mockResolvedValue(mockProposal);
      voteRepo.findOne.mockResolvedValue({} as Vote);

      await expect(
        service.castVote('1', '0x123', true),
      ).rejects.toThrow('already voted');
    });
  });
});

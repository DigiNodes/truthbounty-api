import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Proposal,
  ProposalStatus,
  ProposalCategory,
} from './entities/proposal.entity';
import { Vote } from './entities/proposal.entity';
import { GovernanceCache } from './governance.cache';

export interface FindProposalsDto {
  status?: ProposalStatus;
  category?: ProposalCategory;
  proposer?: string;
  limit?: number;
  offset?: number;
  sort?: 'newest' | 'oldest' | 'most_votes' | 'highest_participation';
}

export interface PaginatedProposals {
  items: Proposal[];
  total: number;
  limit: number;
  offset: number;
}

export interface GovernanceStats {
  totalProposals: number;
  activeProposals: number;
  participationRate: number;
  averageQuorum: number;
  proposalSuccessRate: number;
}

@Injectable()
export class GovernanceService {
  private readonly logger = new Logger(GovernanceService.name);

  constructor(
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    @InjectRepository(Vote)
    private readonly voteRepository: Repository<Vote>,
    private readonly governanceCache: GovernanceCache,
  ) {}

  // ─── Proposals ──────────────────────────────────────────────────────────

  async findOne(id: string): Promise<Proposal | null> {
    const cached = await this.governanceCache.getProposal(id);
    if (cached) return cached;

    const proposal = await this.proposalRepository.findOneBy({ id });
    if (proposal) {
      await this.governanceCache.setProposal(id, proposal);
    }
    return proposal;
  }

  async create(data: {
    title: string;
    description: string;
    proposer: string;
    category?: ProposalCategory;
    blockchainTxHash?: string;
    metadata?: Record<string, any>;
  }): Promise<Proposal> {
    if (!data.title?.trim()) {
      throw new BadRequestException('Proposal title is required');
    }
    if (!data.description?.trim()) {
      throw new BadRequestException('Proposal description is required');
    }
    if (!data.proposer?.trim()) {
      throw new BadRequestException('Proposer address is required');
    }

    const proposal = this.proposalRepository.create({
      title: data.title.trim(),
      description: data.description.trim(),
      proposer: data.proposer.toLowerCase(),
      category: data.category ?? ProposalCategory.PROTOCOL_UPGRADE,
      status: ProposalStatus.PENDING,
      blockchainTxHash: data.blockchainTxHash ?? null,
      metadata: data.metadata ?? {},
    });

    const saved = await this.proposalRepository.save(proposal);
    await this.governanceCache.invalidateAll();

    this.logger.log(
      `Proposal ${saved.id} created by ${saved.proposer} — category=${saved.category}`,
    );
    return saved;
  }

  async activate(id: string): Promise<Proposal> {
    const proposal = await this.findOneOrThrow(id);

    if (proposal.status !== ProposalStatus.PENDING) {
      throw new BadRequestException(
        `Cannot activate proposal ${id}: current status is ${proposal.status}`,
      );
    }

    proposal.status = ProposalStatus.ACTIVE;
    proposal.votingStartsAt = new Date();

    const saved = await this.proposalRepository.save(proposal);
    await this.governanceCache.invalidateProposal(id);

    this.logger.log(`Proposal ${id} activated`);
    return saved;
  }

  async execute(id: string): Promise<Proposal> {
    const proposal = await this.findOneOrThrow(id);

    if (proposal.status !== ProposalStatus.PASSED) {
      throw new BadRequestException(
        `Cannot execute proposal ${id}: current status is ${proposal.status}`,
      );
    }

    proposal.status = ProposalStatus.EXECUTED;
    proposal.executedAt = new Date();

    const saved = await this.proposalRepository.save(proposal);
    await this.governanceCache.invalidateProposal(id);

    this.logger.log(`Proposal ${id} executed`);
    return saved;
  }

  async cancel(id: string): Promise<Proposal> {
    const proposal = await this.findOneOrThrow(id);

    if (
      proposal.status === ProposalStatus.EXECUTED ||
      proposal.status === ProposalStatus.CANCELLED
    ) {
      throw new BadRequestException(
        `Cannot cancel proposal ${id}: current status is ${proposal.status}`,
      );
    }

    proposal.status = ProposalStatus.CANCELLED;

    const saved = await this.proposalRepository.save(proposal);
    await this.governanceCache.invalidateProposal(id);

    this.logger.log(`Proposal ${id} cancelled`);
    return saved;
  }

  async findAll(dto: FindProposalsDto = {}): Promise<PaginatedProposals> {
    const {
      status,
      category,
      proposer,
      limit = 50,
      offset = 0,
      sort = 'newest',
    } = dto;

    if (limit < 1 || limit > 200) {
      throw new BadRequestException('limit must be between 1 and 200');
    }

    const qb = this.proposalRepository
      .createQueryBuilder('p')
      .skip(offset)
      .take(limit);

    if (status) qb.andWhere('p.status = :status', { status });
    if (category) qb.andWhere('p.category = :category', { category });
    if (proposer) qb.andWhere('p.proposer = :proposer', { proposer: proposer.toLowerCase() });

    switch (sort) {
      case 'oldest':
        qb.orderBy('p.createdAt', 'ASC');
        break;
      case 'most_votes':
        qb.orderBy('p.totalVotes', 'DESC');
        break;
      case 'highest_participation':
        qb.orderBy('p.participationRate', 'DESC');
        break;
      case 'newest':
      default:
        qb.orderBy('p.createdAt', 'DESC');
        break;
    }

    const [items, total] = await qb.getManyAndCount();
    return { items, total, limit, offset };
  }

  async findActive(): Promise<Proposal[]> {
    const cached = await this.governanceCache.getActiveProposals();
    if (cached) return cached;

    const proposals = await this.proposalRepository.find({
      where: { status: ProposalStatus.ACTIVE },
      order: { createdAt: 'DESC' },
    });

    await this.governanceCache.setActiveProposals(proposals);
    return proposals;
  }

  // ─── Voting ─────────────────────────────────────────────────────────────

  async castVote(
    proposalId: string,
    voter: string,
    support: boolean,
    weight: number = 1,
    metadata?: Record<string, any>,
  ): Promise<Vote> {
    const proposal = await this.findOneOrThrow(proposalId);

    if (proposal.status !== ProposalStatus.ACTIVE) {
      throw new BadRequestException(
        `Cannot vote on proposal ${proposalId}: current status is ${proposal.status}`,
      );
    }

    const existingVote = await this.voteRepository.findOne({
      where: { proposalId, voter: voter.toLowerCase() },
    });

    if (existingVote) {
      throw new ConflictException(
        `Wallet ${voter} has already voted on proposal ${proposalId}`,
      );
    }

    const vote = this.voteRepository.create({
      proposalId,
      voter: voter.toLowerCase(),
      support,
      weight,
      metadata: metadata ?? {},
    });

    const saved = await this.voteRepository.save(vote);

    // Update proposal vote counts
    proposal.totalVotes += 1;
    if (support) {
      proposal.votesFor += 1;
    } else {
      proposal.votesAgainst += 1;
    }

    await this.proposalRepository.save(proposal);
    await this.governanceCache.invalidateProposal(proposalId);

    this.logger.log(
      `Vote cast on proposal ${proposalId} by ${voter} — support=${support}`,
    );
    return saved;
  }

  async getVotesForProposal(proposalId: string): Promise<Vote[]> {
    const cached = await this.governanceCache.getVotes(proposalId);
    if (cached) return cached;

    const votes = await this.voteRepository.find({
      where: { proposalId },
      order: { createdAt: 'DESC' },
    });

    await this.governanceCache.setVotes(proposalId, votes);
    return votes;
  }

  // ─── Analytics ──────────────────────────────────────────────────────────

  async getStats(): Promise<GovernanceStats> {
    const cached = await this.governanceCache.getStats();
    if (cached) return cached;

    const totalProposals = await this.proposalRepository.count();

    const activeProposals = await this.proposalRepository.count({
      where: { status: ProposalStatus.ACTIVE },
    });

    const passedProposals = await this.proposalRepository.count({
      where: { status: ProposalStatus.PASSED },
    });

    const executedProposals = await this.proposalRepository.count({
      where: { status: ProposalStatus.EXECUTED },
    });

    const totalResolved = passedProposals + executedProposals;
    const proposalSuccessRate =
      totalProposals > 0 ? totalResolved / totalProposals : 0;

    const allProposals = await this.proposalRepository.find();
    const avgParticipation =
      allProposals.length > 0
        ? allProposals.reduce((sum, p) => sum + Number(p.participationRate), 0) /
          allProposals.length
        : 0;
    const avgQuorum =
      allProposals.length > 0
        ? allProposals.reduce((sum, p) => sum + Number(p.quorumProgress), 0) /
          allProposals.length
        : 0;

    const stats: GovernanceStats = {
      totalProposals,
      activeProposals,
      participationRate: Number(avgParticipation.toFixed(4)),
      averageQuorum: Number(avgQuorum.toFixed(4)),
      proposalSuccessRate: Number(proposalSuccessRate.toFixed(4)),
    };

    await this.governanceCache.setStats(stats);
    return stats;
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private async findOneOrThrow(id: string): Promise<Proposal> {
    const proposal = await this.findOne(id);
    if (!proposal) {
      throw new NotFoundException(`Proposal with ID ${id} not found`);
    }
    return proposal;
  }
}

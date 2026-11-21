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
  GovernanceRecordKind,
  GovernanceDataState,
  Vote,
  VoteSupportMode,
} from './entities/proposal.entity';
import { GovernanceCache } from './governance.cache';
import {
  CanonicalEventRef,
  GovernanceEvidenceService,
} from './canonical-governance-evidence.service';

const PRINCIPAL_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

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

/**
 * GovernanceService — off-chain drafts plus canonical-event projections.
 *
 * No caller-supplied identity, weight or "on-chain proof" is ever persisted.
 * The proposer/voter comes from the verified JWT principal, and every chain
 * field comes from GovernanceEvidenceService (approved deployment, finalized
 * checkpoint, canonical log identity). Vote totals are recomputed from the
 * resulting canonical vote rows, so they can be rebuilt deterministically.
 *
 * The smart contract remains authoritative. Status changes here are indexing
 * labels for canonical records; drafts are explicitly marked and can never be
 * activated or executed as protocol proposals.
 */
@Injectable()
export class GovernanceService {
  private readonly logger = new Logger(GovernanceService.name);

  constructor(
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    @InjectRepository(Vote)
    private readonly voteRepository: Repository<Vote>,
    private readonly governanceCache: GovernanceCache,
    private readonly evidence: GovernanceEvidenceService,
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
    canonicalEvent?: CanonicalEventRef;
    metadata?: Record<string, any>;
  }): Promise<Proposal> {
    if (!data.title?.trim()) {
      throw new BadRequestException('Proposal title is required');
    }
    if (!data.description?.trim()) {
      throw new BadRequestException('Proposal description is required');
    }
    const proposer = this.assertPrincipal(data.proposer);

    const canonical = data.canonicalEvent
      ? await this.evidence.assertProposalCreated(data.canonicalEvent, proposer)
      : null;

    const proposal = this.proposalRepository.create({
      title: data.title.trim(),
      description: data.description.trim(),
      proposer,
      category: data.category ?? ProposalCategory.PROTOCOL_UPGRADE,
      status: ProposalStatus.PENDING,
      recordKind: canonical
        ? GovernanceRecordKind.CANONICAL
        : GovernanceRecordKind.OFFCHAIN_DRAFT,
      dataState: canonical
        ? GovernanceDataState.FINALIZED
        : GovernanceDataState.DRAFT,
      chainId: canonical?.chainId ?? null,
      governorAddress: canonical?.governorAddress ?? null,
      canonicalProposalId: canonical?.proposalId ?? null,
      blockchainTxHash: canonical?.txHash ?? null,
      creationLogIndex: canonical?.logIndex ?? null,
      creationBlockNumber: canonical?.blockNumber ?? null,
      artifactVersion: canonical?.artifactVersion ?? null,
      metadata: data.metadata ?? {},
    });

    const saved = await this.proposalRepository.save(proposal);
    await this.governanceCache.invalidateAll();

    this.logger.log(
      `Proposal ${saved.id} created by ${saved.proposer} — ` +
        `kind=${saved.recordKind}, state=${saved.dataState}`,
    );
    return saved;
  }

  async activate(id: string): Promise<Proposal> {
    const proposal = await this.findOneOrThrow(id);
    this.assertCanonical(proposal, 'activate');

    if (proposal.status !== ProposalStatus.PENDING) {
      throw new BadRequestException(
        `Cannot activate proposal ${id}: current status is ${proposal.status}`,
      );
    }

    proposal.status = ProposalStatus.ACTIVE;
    proposal.votingStartsAt = new Date();

    const saved = await this.proposalRepository.save(proposal);
    await this.governanceCache.invalidateProposal(id);
    this.logger.log(
      `Canonical proposal ${id} marked active (index label only)`,
    );
    return saved;
  }

  async execute(id: string): Promise<Proposal> {
    const proposal = await this.findOneOrThrow(id);
    this.assertCanonical(proposal, 'execute');

    if (proposal.status !== ProposalStatus.PASSED) {
      throw new BadRequestException(
        `Cannot execute proposal ${id}: current status is ${proposal.status}`,
      );
    }

    proposal.status = ProposalStatus.EXECUTED;
    proposal.executedAt = new Date();

    const saved = await this.proposalRepository.save(proposal);
    await this.governanceCache.invalidateProposal(id);
    this.logger.log(`Canonical proposal ${id} execution confirmed locally`);
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
    if (proposer)
      qb.andWhere('p.proposer = :proposer', {
        proposer: proposer.toLowerCase(),
      });

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
    principalAddress: string,
    canonicalEvent: CanonicalEventRef,
    metadata?: Record<string, any>,
  ): Promise<Vote> {
    const principal = this.assertPrincipal(principalAddress);
    const proposal = await this.findOneOrThrow(proposalId);
    this.assertCanonical(proposal, 'vote on');

    if (proposal.status !== ProposalStatus.ACTIVE) {
      throw new BadRequestException(
        `Cannot vote on proposal ${proposalId}: current status is ${proposal.status}`,
      );
    }
    if (!canonicalEvent) {
      throw new BadRequestException('CANONICAL_EVENT_REQUIRED');
    }

    const event = await this.evidence.assertVoteCast(
      canonicalEvent,
      principal,
      proposal.canonicalProposalId as string,
    );

    const duplicate = await this.voteRepository.findOne({
      where: {
        chainId: event.chainId,
        governorAddress: event.governorAddress,
        canonicalProposalId: event.proposalId,
        voter: event.voter,
        txHash: event.txHash,
        logIndex: event.logIndex,
      },
    });
    if (duplicate) {
      throw new ConflictException('CANONICAL_VOTE_ALREADY_RECORDED');
    }

    const existingVoterVote = await this.voteRepository.findOne({
      where: { proposalId, voter: event.voter },
    });
    if (existingVoterVote) {
      throw new ConflictException(
        `Wallet ${event.voter} has already voted on proposal ${proposalId}`,
      );
    }

    const vote = this.voteRepository.create({
      proposalId,
      voter: event.voter,
      support: event.support,
      supportMode: event.supportMode as VoteSupportMode,
      weight: event.weight,
      chainId: event.chainId,
      governorAddress: event.governorAddress,
      canonicalProposalId: event.proposalId,
      txHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      artifactVersion: event.artifactVersion,
      dataState: GovernanceDataState.FINALIZED,
      metadata: metadata ?? {},
    });

    const saved = await this.voteRepository.save(vote);
    await this.rebuildProposalTotals(proposalId);

    this.logger.log(
      `Projected VoteCast ${event.txHash}:${event.logIndex} on ${proposalId}`,
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

  // ─── Rebuild / reorg reconciliation ────────────────────────────────────

  /** Recompute every total from canonical vote rows. Idempotent. */
  async rebuildProposalTotals(proposalId: string): Promise<Proposal> {
    const proposal = await this.proposalRepository.findOneBy({
      id: proposalId,
    });
    if (!proposal) {
      throw new NotFoundException(`Proposal with ID ${proposalId} not found`);
    }

    const votes = await this.voteRepository.find({ where: { proposalId } });
    let forWeight = 0n;
    let againstWeight = 0n;
    let abstainWeight = 0n;

    for (const vote of votes) {
      const weight = BigInt(vote.weight ?? '0');
      if (vote.supportMode === VoteSupportMode.FOR) forWeight += weight;
      else if (vote.supportMode === VoteSupportMode.AGAINST)
        againstWeight += weight;
      else abstainWeight += weight;
    }

    proposal.totalVotes = votes.length;
    proposal.votesFor = votes.filter(
      (v) => v.supportMode === VoteSupportMode.FOR,
    ).length;
    proposal.votesAgainst = votes.filter(
      (v) => v.supportMode === VoteSupportMode.AGAINST,
    ).length;
    proposal.voteWeightFor = forWeight.toString();
    proposal.voteWeightAgainst = againstWeight.toString();
    proposal.voteWeightAbstain = abstainWeight.toString();

    const saved = await this.proposalRepository.save(proposal);
    await this.governanceCache.invalidateProposal(proposalId);
    return saved;
  }

  async rebuildAllProposalTotals(): Promise<number> {
    const proposals = await this.proposalRepository.find();
    for (const proposal of proposals) {
      await this.rebuildProposalTotals(proposal.id);
    }
    return proposals.length;
  }

  /**
   * Deterministic reorg handling: remove projections above the new canonical
   * head and recompute totals. A reorged creation event demotes its proposal
   * back to an off-chain draft instead of leaving a phantom on-chain record.
   */
  async reconcileReorg(
    chainId: number,
    rollbackToBlock: bigint,
  ): Promise<{
    votesRemoved: number;
    proposalsDemoted: number;
  }> {
    const rollbackBlock = rollbackToBlock.toString();

    const staleVotes = await this.voteRepository
      .createQueryBuilder('v')
      .where('v.chainId = :chainId', { chainId })
      .andWhere('CAST(v.blockNumber AS NUMERIC) > :rollbackBlock', {
        rollbackBlock,
      })
      .getMany();
    for (const vote of staleVotes) {
      await this.voteRepository.delete({ id: vote.id });
    }

    const affected = new Set(staleVotes.map((v) => v.proposalId));
    const staleProposals = await this.proposalRepository
      .createQueryBuilder('p')
      .where('p.chainId = :chainId', { chainId })
      .andWhere('p.recordKind = :recordKind', {
        recordKind: GovernanceRecordKind.CANONICAL,
      })
      .andWhere('CAST(p.creationBlockNumber AS NUMERIC) > :rollbackBlock', {
        rollbackBlock,
      })
      .getMany();
    for (const proposal of staleProposals) {
      proposal.recordKind = GovernanceRecordKind.OFFCHAIN_DRAFT;
      proposal.dataState = GovernanceDataState.DRAFT;
      proposal.status = ProposalStatus.PENDING;
      proposal.canonicalProposalId = null;
      proposal.governorAddress = null;
      proposal.blockchainTxHash = null;
      proposal.creationLogIndex = null;
      proposal.creationBlockNumber = null;
      proposal.artifactVersion = null;
      affected.add(proposal.id);
      await this.proposalRepository.save(proposal);
    }

    for (const proposalId of affected) {
      await this.rebuildProposalTotals(proposalId);
    }
    await this.governanceCache.invalidateAll();

    return {
      votesRemoved: staleVotes.length,
      proposalsDemoted: staleProposals.length,
    };
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
        ? allProposals.reduce(
            (sum, p) => sum + Number(p.participationRate),
            0,
          ) / allProposals.length
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

  private assertPrincipal(address: unknown): string {
    if (
      typeof address !== 'string' ||
      !PRINCIPAL_ADDRESS_PATTERN.test(address)
    ) {
      throw new BadRequestException('INVALID_VERIFIED_PRINCIPAL');
    }
    return address.toLowerCase();
  }

  private assertCanonical(proposal: Proposal, action: string): void {
    if (proposal.recordKind !== GovernanceRecordKind.CANONICAL) {
      throw new BadRequestException(
        `Cannot ${action} an off-chain draft: only canonical proposals ` +
          'carry protocol state',
      );
    }
  }

  private async findOneOrThrow(id: string): Promise<Proposal> {
    const proposal = await this.findOne(id);
    if (!proposal) {
      throw new NotFoundException(`Proposal with ID ${id} not found`);
    }
    return proposal;
  }
}

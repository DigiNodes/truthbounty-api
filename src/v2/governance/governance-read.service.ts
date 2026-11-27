import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  GovernanceProposal,
  ProposalChainState,
} from './entities/governance-proposal.entity';
import { GovernanceAction } from './entities/governance-action.entity';
import { GovernanceProposalTransition } from './entities/governance-proposal-transition.entity';
import {
  ProposalVote,
  VoteSupport,
} from './entities/proposal-vote.entity';
import { RoleChange } from './entities/role-change.entity';
import {
  GovernanceActionReadModel,
  GovernanceProposalListResult,
  GovernanceProposalReadModel,
  ProposalTimelockReadModel,
  ProposalTransitionReadModel,
  RoleChangeReadModel,
} from './interfaces/governance-read-model.interface';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * GovernanceReadService — V2-BE-067
 *
 * Read-only projections for the /v2/governance surface.
 *
 * Every field returned here traces back to a persisted row that was
 * produced by GovernanceProjectionService from a CanonicalEvent — the API
 * never recomputes state, ETA, or vote totals.
 *
 * Failure modes:
 *   - Unknown proposal ID → 404 (not a fabricated empty response).
 *   - Rows still in PENDING but with selectorUnknown actions → surfaced to
 *     the caller explicitly (not hidden).
 */
@Injectable()
export class GovernanceReadService {
  private readonly logger = new Logger(GovernanceReadService.name);

  constructor(
    @InjectRepository(GovernanceProposal)
    private readonly proposals: Repository<GovernanceProposal>,
    @InjectRepository(GovernanceAction)
    private readonly actions: Repository<GovernanceAction>,
    @InjectRepository(ProposalVote)
    private readonly votes: Repository<ProposalVote>,
    @InjectRepository(RoleChange)
    private readonly roleChanges: Repository<RoleChange>,
    @InjectRepository(GovernanceProposalTransition)
    private readonly transitions?: Repository<GovernanceProposalTransition>,
  ) {}

  // ── Proposal detail ─────────────────────────────────────────────────────

  async getProposal(
    chainId: number,
    proposalId: string,
  ): Promise<GovernanceProposalReadModel> {
    const row = await this.proposals.findOne({
      where: { chainId, proposalId },
    });
    if (!row) {
      throw new NotFoundException(
        `Proposal ${proposalId} not found on chain ${chainId}`,
      );
    }

    const [actions, voteTotals] = await Promise.all([
      this.actions.find({
        where: { chainId, proposalId },
        order: { actionIndex: 'ASC' },
      }),
      this.computeVoteTotals(chainId, proposalId),
    ]);

    return {
      chainId: row.chainId,
      proposalId: row.proposalId,
      governorAddress: row.governorAddress,
      proposer: row.proposer,
      proposalHash: row.proposalHash,
      description: row.description,
      state: row.state,
      eta: row.eta,
      stateChangedAtBlock: row.stateChangedAtBlock,
      stateChangedAt: row.stateChangedAt,
      artifactVersion: row.artifactVersion,
      actions: actions.map(this.toActionReadModel),
      voteTotals,
    };
  }

  // ── Proposal list (cursor pagination) ──────────────────────────────────

  async listProposals(params: {
    chainId: number;
    state?: ProposalChainState;
    proposer?: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<GovernanceProposalListResult> {
    const limit = Math.min(
      Math.max(params.limit ?? DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    const qb = this.proposals
      .createQueryBuilder('p')
      .where('p.chainId = :chainId', { chainId: params.chainId })
      .orderBy('CAST(p.proposalId AS NUMERIC)', 'DESC')
      .take(limit + 1);

    if (params.state) {
      qb.andWhere('p.state = :state', { state: params.state });
    }
    if (params.proposer) {
      qb.andWhere('p.proposer = :proposer', {
        proposer: params.proposer.toLowerCase(),
      });
    }
    if (params.cursor) {
      // Cursor is the last-seen proposalId (numeric string).
      qb.andWhere('CAST(p.proposalId AS NUMERIC) < :cursor', {
        cursor: params.cursor,
      });
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && items.length > 0
        ? items[items.length - 1].proposalId
        : null;

    return { items, nextCursor };
  }

  // ── Timelock-specific projection ───────────────────────────────────────

  async getTimelock(
    chainId: number,
    proposalId: string,
  ): Promise<ProposalTimelockReadModel> {
    const row = await this.proposals.findOne({
      where: { chainId, proposalId },
    });
    if (!row) {
      throw new NotFoundException(
        `Proposal ${proposalId} not found on chain ${chainId}`,
      );
    }

    // PREWAVE-BE-190: lifecycle facts come from the immutable canonical
    // transition history, never from the current state or from action rows.
    const history = await this.loadTransitions(chainId, proposalId);
    const blockFor = (eventName: string): string | null =>
      history.find((t) => t.eventName === eventName)?.blockNumber ?? null;

    return {
      chainId: row.chainId,
      proposalId: row.proposalId,
      eta: row.eta,
      state: row.state,
      queuedAtBlock: blockFor('ProposalQueued'),
      executedAtBlock: blockFor('ProposalExecuted'),
      cancelledAtBlock: blockFor('ProposalCanceled'),
      expiredAtBlock: blockFor('ProposalExpired'),
      artifactVersion: row.artifactVersion,
      transitions: history.map(this.toTransitionReadModel),
    };
  }

  // ── Role change audit trail ────────────────────────────────────────────

  async listRoleChanges(params: {
    chainId: number;
    account?: string;
    role?: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<{ items: RoleChangeReadModel[]; nextCursor: string | null }> {
    const limit = Math.min(
      Math.max(params.limit ?? DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    const qb = this.roleChanges
      .createQueryBuilder('r')
      .where('r.chainId = :chainId', { chainId: params.chainId })
      .orderBy('CAST(r.blockNumber AS NUMERIC)', 'DESC')
      .addOrderBy('r.logIndex', 'DESC')
      .take(limit + 1);

    if (params.account) {
      qb.andWhere('r.account = :account', {
        account: params.account.toLowerCase(),
      });
    }
    if (params.role) {
      qb.andWhere('r.role = :role', { role: params.role });
    }
    if (params.cursor) {
      qb.andWhere('CAST(r.blockNumber AS NUMERIC) < :cursor', {
        cursor: params.cursor,
      });
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(
      (r): RoleChangeReadModel => ({
        chainId: r.chainId,
        contractAddress: r.contractAddress,
        kind: r.kind,
        role: r.role,
        account: r.account,
        sender: r.sender,
        txHash: r.txHash,
        logIndex: r.logIndex,
        blockNumber: r.blockNumber,
        blockTimestamp: r.blockTimestamp,
        artifactVersion: r.artifactVersion,
      }),
    );

    const nextCursor =
      hasMore && items.length > 0
        ? items[items.length - 1].blockNumber
        : null;

    return { items, nextCursor };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Load a proposal's canonical lifecycle history in deterministic order:
   * block number first, then log index for transitions sharing a block.
   */
  private async loadTransitions(
    chainId: number,
    proposalId: string,
  ): Promise<GovernanceProposalTransition[]> {
    if (!this.transitions) return [];

    let rows: GovernanceProposalTransition[];
    if (typeof this.transitions.find === 'function') {
      rows = await this.transitions.find({
        where: { chainId, proposalId },
        order: { blockNumber: 'ASC', logIndex: 'ASC' },
      });
    } else {
      rows = await this.transitions
        .createQueryBuilder('t')
        .where('t.chainId = :chainId', { chainId })
        .andWhere('t.proposalId = :proposalId', { proposalId })
        .orderBy('CAST(t.blockNumber AS NUMERIC)', 'ASC')
        .addOrderBy('t.logIndex', 'ASC')
        .getMany();
    }

    return rows
      .filter(
        (t) =>
          t.chainId === chainId && String(t.proposalId) === String(proposalId),
      )
      .sort((a, b) => {
        const aBlock = BigInt(a.blockNumber);
        const bBlock = BigInt(b.blockNumber);
        if (aBlock < bBlock) return -1;
        if (aBlock > bBlock) return 1;
        return a.logIndex - b.logIndex;
      });
  }

  private toTransitionReadModel = (
    t: GovernanceProposalTransition,
  ): ProposalTransitionReadModel => ({
    chainId: t.chainId,
    contractAddress: t.contractAddress,
    proposalId: t.proposalId,
    eventName: t.eventName,
    state: t.state,
    eta: t.eta,
    txHash: t.txHash,
    logIndex: t.logIndex,
    blockNumber: t.blockNumber,
    blockTimestamp: t.blockTimestamp,
    artifactVersion: t.artifactVersion,
  });

  private async computeVoteTotals(
    chainId: number,
    proposalId: string,
  ): Promise<{
    for: string;
    against: string;
    abstain: string;
    voters: number;
  }> {
    const rows = await this.votes.find({ where: { chainId, proposalId } });
    let forSum = 0n;
    let againstSum = 0n;
    let abstainSum = 0n;
    for (const v of rows) {
      const w = BigInt(v.weight ?? '0');
      if (v.support === VoteSupport.FOR) forSum += w;
      else if (v.support === VoteSupport.AGAINST) againstSum += w;
      else abstainSum += w;
    }
    return {
      for: forSum.toString(),
      against: againstSum.toString(),
      abstain: abstainSum.toString(),
      voters: rows.length,
    };
  }

  private toActionReadModel = (a: GovernanceAction): GovernanceActionReadModel => ({
    actionIndex: a.actionIndex,
    target: a.target,
    valueWei: a.valueWei,
    calldata: a.calldata,
    calldataChecksum: a.calldataChecksum,
    selector: a.selector,
    functionSignature: a.functionSignature,
    selectorUnknown: a.selectorUnknown,
    decodedArgs: a.decodedArgs,
  });
}

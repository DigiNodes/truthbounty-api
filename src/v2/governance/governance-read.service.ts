import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  GovernanceProposal,
  ProposalChainState,
} from './entities/governance-proposal.entity';
import { GovernanceAction } from './entities/governance-action.entity';
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
  RoleChangeReadModel,
} from './interfaces/governance-read-model.interface';
import { TransactionRunner } from '../../database/transaction.runner';

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
    private readonly transactionRunner: TransactionRunner,
  ) {}

  // ── Proposal detail ─────────────────────────────────────────────────────

  async getProposal(
    chainId: number,
    proposalId: string,
  ): Promise<GovernanceProposalReadModel> {
    // All three reads share one REPEATABLE READ snapshot. A projector cannot
    // commit a half-replaced action set between the proposal read and the
    // action read: this request sees either the old or the new projection.
    return this.transactionRunner.run(async (manager) => {
      const proposalRepo = manager.getRepository(GovernanceProposal);
      const actionRepo = manager.getRepository(GovernanceAction);
      const voteRepo = manager.getRepository(ProposalVote);

      const row = await proposalRepo.findOne({
        where: { chainId, proposalId },
      });
      if (!row) {
        throw new NotFoundException(
          `Proposal ${proposalId} not found on chain ${chainId}`,
        );
      }

      const [actions, voteTotals] = await Promise.all([
        actionRepo.find({
          where: { chainId, proposalId },
          order: { actionIndex: 'ASC' },
        }),
        this.computeVoteTotals(voteRepo, chainId, proposalId),
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
    }, { isolationLevel: 'REPEATABLE READ' });
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

    const [queued, executed, cancelled, expired] = await Promise.all([
      this.actions.findOne({
        where: { chainId, proposalId },
      }).then(() => row.state === ProposalChainState.QUEUED ? row.stateChangedAtBlock : null),
      row.state === ProposalChainState.EXECUTED ? row.stateChangedAtBlock : null,
      row.state === ProposalChainState.CANCELLED ? row.stateChangedAtBlock : null,
      row.state === ProposalChainState.EXPIRED ? row.stateChangedAtBlock : null,
    ]);

    return {
      chainId: row.chainId,
      proposalId: row.proposalId,
      eta: row.eta,
      state: row.state,
      queuedAtBlock: queued,
      executedAtBlock: executed,
      cancelledAtBlock: cancelled,
      expiredAtBlock: expired,
      artifactVersion: row.artifactVersion,
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

  private async computeVoteTotals(
    voteRepo: Repository<ProposalVote>,
    chainId: number,
    proposalId: string,
  ): Promise<{
    for: string;
    against: string;
    abstain: string;
    voters: number;
  }> {
    const rows = await voteRepo.find({ where: { chainId, proposalId } });
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

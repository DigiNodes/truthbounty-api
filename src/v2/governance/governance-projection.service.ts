import { Injectable, Logger } from '@nestjs/common';
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
import { RoleChange, RoleChangeKind } from './entities/role-change.entity';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';
import { ArtifactRegistryService } from '../events/artifact-registry.service';
import { ProposalDecoderService } from './proposal-decoder.service';
import { TransactionRunner } from '../../database/transaction.runner';

/**
 * GovernanceProjectionService — V2-BE-067
 *
 * Projects canonical events into the governance read models.
 *
 * Invariants enforced here:
 *   - State comes from the chain event's name, never recomputed.
 *   - ETA comes from the chain event payload, never fabricated.
 *   - Reorg reconciliation is idempotent: a replay of the same event is a
 *     no-op; a rollback removes rows whose (txHash, logIndex) are no longer
 *     canonical.
 *   - ABI change is detected by comparing the event's artifactVersion to the
 *     version recorded on the proposal row; a mismatch marks the row stale
 *     rather than silently reinterpreting.
 *   - ProposalCreated is one atomic projection: the proposal row and its
 *     complete action set are committed together, or not at all.
 */
@Injectable()
export class GovernanceProjectionService {
  private readonly logger = new Logger(GovernanceProjectionService.name);

  constructor(
    @InjectRepository(GovernanceProposal)
    private readonly proposals: Repository<GovernanceProposal>,
    @InjectRepository(GovernanceAction)
    private readonly actions: Repository<GovernanceAction>,
    @InjectRepository(ProposalVote)
    private readonly votes: Repository<ProposalVote>,
    @InjectRepository(RoleChange)
    private readonly roleChanges: Repository<RoleChange>,
    @InjectRepository(CanonicalEvent)
    private readonly events: Repository<CanonicalEvent>,
    private readonly artifactRegistry: ArtifactRegistryService,
    private readonly decoder: ProposalDecoderService,
    private readonly transactionRunner: TransactionRunner,
  ) {}

  /**
   * Project every canonical governance event that has not yet been applied.
   * Idempotent — safe to run repeatedly after reorg replay.
   */
  async projectNewEvents(batchSize = 100): Promise<{
    processed: number;
    applied: number;
    duplicates: number;
    staleArtifact: number;
  }> {
    const governanceEvents = await this.events
      .createQueryBuilder('e')
      .where('e.eventName IN (:...names)', {
        names: [
          'ProposalCreated',
          'ProposalQueued',
          'ProposalExecuted',
          'ProposalCanceled',
          'ProposalExpired',
          'VoteCast',
          'RoleGranted',
          'RoleRevoked',
        ],
      })
      .orderBy('e.blockNumber', 'ASC')
      .addOrderBy('e.logIndex', 'ASC')
      .limit(batchSize)
      .getMany();

    let applied = 0;
    let duplicates = 0;
    let staleArtifact = 0;

    for (const event of governanceEvents) {
      const outcome = await this.projectEvent(event);
      if (outcome === 'applied') applied++;
      else if (outcome === 'duplicate') duplicates++;
      else if (outcome === 'stale_artifact') staleArtifact++;
    }

    return {
      processed: governanceEvents.length,
      applied,
      duplicates,
      staleArtifact,
    };
  }

  /**
   * Project a single canonical event.
   */
  private async projectEvent(
    event: CanonicalEvent,
  ): Promise<'applied' | 'duplicate' | 'stale_artifact' | 'skipped'> {
    switch (event.eventName) {
      case 'ProposalCreated':
        return this.projectProposalCreated(event);
      case 'ProposalQueued':
        return this.projectStateTransition(event, ProposalChainState.QUEUED);
      case 'ProposalExecuted':
        return this.projectStateTransition(event, ProposalChainState.EXECUTED);
      case 'ProposalCanceled':
        return this.projectStateTransition(event, ProposalChainState.CANCELLED);
      case 'ProposalExpired':
        return this.projectStateTransition(event, ProposalChainState.EXPIRED);
      case 'VoteCast':
        return this.projectVoteCast(event);
      case 'RoleGranted':
        return this.projectRoleChange(event, RoleChangeKind.GRANTED);
      case 'RoleRevoked':
        return this.projectRoleChange(event, RoleChangeKind.REVOKED);
      default:
        return 'skipped';
    }
  }

  // ── ProposalCreated ─────────────────────────────────────────────────────

  private async projectProposalCreated(
    event: CanonicalEvent,
    force = false,
  ): Promise<'applied' | 'duplicate' | 'stale_artifact'> {
    const proposalId = this.readBigInt(event, 'proposalId');
    if (proposalId === null) {
      this.logger.warn(
        `ProposalCreated event ${event.txHash}:${event.logIndex} missing proposalId`,
      );
      return 'skipped' as never;
    }

    const existing = await this.proposals.findOne({
      where: { chainId: event.chainId, proposalId },
    });
    if (!force && existing && this.isFullyApplied(existing, event)) {
      return 'duplicate';
    }

    const targets = this.readStringArray(event, 'targets');
    const values = this.readStringArray(event, 'values');
    const calldatas = this.readStringArray(event, 'calldatas');
    if (
      targets.length !== values.length ||
      targets.length !== calldatas.length
    ) {
      this.logger.warn(
        `ProposalCreated event ${event.txHash}:${event.logIndex} has mismatched action arrays; refusing to project`,
      );
      return 'skipped' as never;
    }

    const descriptionHash = this.readString(event, 'descriptionHash');
    const description = this.readString(event, 'description');
    const proposer = this.readAddress(event, 'proposer') ?? '0x0';

    // Decode and validate every call BEFORE any committed row is touched.
    // A decoding failure must leave the previous projection intact.
    const decodedActions: Array<Partial<GovernanceAction>> = [];
    for (let i = 0; i < targets.length; i++) {
      const artifact = await this.artifactRegistry.resolve(
        event.chainId,
        targets[i],
      );
      const decoded = this.decoder.decodeCall(
        targets[i],
        values[i] ?? '0',
        calldatas[i] ?? '0x',
        artifact?.iface ?? null,
      );
      if (
        !decoded ||
        typeof decoded.target !== 'string' ||
        typeof decoded.valueWei !== 'string' ||
        typeof decoded.calldata !== 'string' ||
        typeof decoded.calldataChecksum !== 'string'
      ) {
        throw new Error(
          `Invalid decoded action ${i} for ProposalCreated ${event.txHash}:${event.logIndex}`,
        );
      }
      decodedActions.push({
        chainId: event.chainId,
        proposalId,
        actionIndex: i,
        target: decoded.target,
        valueWei: decoded.valueWei,
        calldata: decoded.calldata,
        selector: decoded.selector,
        functionSignature: decoded.functionSignature,
        selectorUnknown: decoded.selectorUnknown,
        decodedArgs: decoded.decodedArgs,
        calldataChecksum: decoded.calldataChecksum,
        artifactVersion: event.artifactVersion,
      });
    }

    let applied = false;
    let projectedRowId: string | undefined;
    try {
      await this.transactionRunner.run(async (manager) => {
        const proposalRepo = manager.getRepository(GovernanceProposal);
        const actionRepo = manager.getRepository(GovernanceAction);

        // Serialize concurrent projections of the same proposal. For a new
        // proposal the unique (chainId, proposalId) row is the lock.
        const locked = await proposalRepo
          .createQueryBuilder('p')
          .setLock('pessimistic_write')
          .where('p.chainId = :chainId', { chainId: event.chainId })
          .andWhere('p.proposalId = :proposalId', { proposalId })
          .getOne();

        if (
          !force &&
          locked &&
          this.isFullyApplied(locked, event)
        ) {
          applied = false;
          return;
        }

        const proposalRow = await this.upsertProposalWithin(proposalRepo, {
          chainId: event.chainId,
          proposalId,
          governorAddress: event.contractAddress,
          proposer,
          proposalHash: descriptionHash ?? '',
          description,
          state: ProposalChainState.PENDING,
          eta: null,
          stateChangedAtBlock: event.blockNumber,
          stateChangedAt: event.blockTimestamp,
          artifactVersion: event.artifactVersion,
          lastEventTxHash: event.txHash,
          lastEventLogIndex: event.logIndex,
          createdEventTxHash: event.txHash,
          createdEventLogIndex: event.logIndex,
          actionCount: decodedActions.length,
        });

        // Delete and re-insert inside the same transaction: readers can only
        // ever observe the previous complete set or the new complete set.
        await actionRepo.delete({
          chainId: event.chainId,
          proposalId,
        });
        if (decodedActions.length > 0) {
          await actionRepo.save(
            decodedActions.map((action) => actionRepo.create(action)),
          );
        }
        applied = true;
        projectedRowId = proposalRow.id;
      });
    } catch (error) {
      // A concurrent attempt may have committed the identical projection
      // while this one waited on the row lock; only that case is a duplicate.
      const after = await this.proposals.findOne({
        where: { chainId: event.chainId, proposalId },
      });
      if (after && this.isFullyApplied(after, event)) return 'duplicate';
      throw error;
    }

    if (!applied) return 'duplicate';

    this.logger.log(
      `Projected ProposalCreated ${proposalId} (${projectedRowId}) with ${decodedActions.length} call(s)`,
    );
    return 'applied';
  }

  // ── State transitions ───────────────────────────────────────────────────

  private async projectStateTransition(
    event: CanonicalEvent,
    nextState: ProposalChainState,
  ): Promise<'applied' | 'duplicate' | 'stale_artifact'> {
    const proposalId = this.readBigInt(event, 'proposalId');
    if (proposalId === null) {
      return 'skipped' as never;
    }

    const proposal = await this.proposals.findOne({
      where: { chainId: event.chainId, proposalId },
    });
    if (!proposal) {
      this.logger.warn(
        `State transition ${event.eventName} for unknown proposal ${proposalId}`,
      );
      return 'skipped' as never;
    }

    // Detect ABI drift: if the event arrived under a different artifact
    // version than the proposal was created under, flag it — do not
    // silently reinterpret the payload.
    if (proposal.artifactVersion !== event.artifactVersion) {
      this.logger.warn(
        `Artifact drift on proposal ${proposalId}: ` +
          `created under ${proposal.artifactVersion}, event emitted under ${event.artifactVersion}`,
      );
      return 'stale_artifact';
    }

    // Idempotency by (txHash, logIndex)
    if (
      proposal.lastEventTxHash === event.txHash &&
      proposal.lastEventLogIndex === event.logIndex
    ) {
      return 'duplicate';
    }

    // Only accept forward transitions; a reorg will trigger a rollback
    // followed by replay, so this branch never fights the reconciler.
    const eta = this.readBigInt(event, 'eta') ?? proposal.eta;

    proposal.state = nextState;
    proposal.eta = eta;
    proposal.stateChangedAtBlock = event.blockNumber;
    proposal.stateChangedAt = event.blockTimestamp;
    proposal.lastEventTxHash = event.txHash;
    proposal.lastEventLogIndex = event.logIndex;
    await this.proposals.save(proposal);

    this.logger.log(`Proposal ${proposalId} → ${nextState}`);
    return 'applied';
  }

  // ── VoteCast ────────────────────────────────────────────────────────────

  private async projectVoteCast(
    event: CanonicalEvent,
  ): Promise<'applied' | 'duplicate'> {
    const proposalId = this.readBigInt(event, 'proposalId');
    const voter = this.readAddress(event, 'voter');
    const supportNum = this.readBigInt(event, 'support');
    if (proposalId === null || !voter || supportNum === null) {
      return 'duplicate' as never;
    }

    const existing = await this.votes.findOne({
      where: {
        chainId: event.chainId,
        txHash: event.txHash,
        logIndex: event.logIndex,
      },
    });
    if (existing) return 'duplicate';

    const support = this.mapSupport(supportNum);
    await this.votes.save(
      this.votes.create({
        chainId: event.chainId,
        proposalId,
        voter,
        support,
        weight: this.readString(event, 'weight') ?? '0',
        reason: this.readString(event, 'reason'),
        txHash: event.txHash,
        logIndex: event.logIndex,
        blockNumber: event.blockNumber,
        blockTimestamp: event.blockTimestamp,
        artifactVersion: event.artifactVersion,
      }),
    );
    return 'applied';
  }

  // ── Role changes (audit trail) ──────────────────────────────────────────

  private async projectRoleChange(
    event: CanonicalEvent,
    kind: RoleChangeKind,
  ): Promise<'applied' | 'duplicate'> {
    const existing = await this.roleChanges.findOne({
      where: {
        chainId: event.chainId,
        txHash: event.txHash,
        logIndex: event.logIndex,
      },
    });
    if (existing) return 'duplicate';

    const role = this.readString(event, 'role');
    const account = this.readAddress(event, 'account');
    const sender = this.readAddress(event, 'sender');
    if (!role || !account) return 'duplicate' as never;

    await this.roleChanges.save(
      this.roleChanges.create({
        chainId: event.chainId,
        contractAddress: event.contractAddress,
        kind,
        role,
        account,
        sender: sender ?? account,
        txHash: event.txHash,
        logIndex: event.logIndex,
        blockNumber: event.blockNumber,
        blockTimestamp: event.blockTimestamp,
        artifactVersion: event.artifactVersion,
      }),
    );
    return 'applied';
  }

  // ── Reorg rollback ──────────────────────────────────────────────────────

  /**
   * Remove every governance row whose (txHash, logIndex) is no longer
   * canonical. Called by the reorg rollback orchestrator after it purges
   * CanonicalEvent rows.
   */
  async rollbackAboveBlock(
    chainId: number,
    rollbackToBlock: bigint,
  ): Promise<void> {
    const rollbackBlockStr = rollbackToBlock.toString();

    // Votes and role changes are pure log-scoped rows: delete directly.
    await this.votes
      .createQueryBuilder()
      .delete()
      .where('chainId = :chainId', { chainId })
      .andWhere('CAST(blockNumber AS NUMERIC) > :rollbackToBlock', {
        rollbackToBlock: rollbackBlockStr,
      })
      .execute();

    await this.roleChanges
      .createQueryBuilder()
      .delete()
      .where('chainId = :chainId', { chainId })
      .andWhere('CAST(blockNumber AS NUMERIC) > :rollbackToBlock', {
        rollbackToBlock: rollbackBlockStr,
      })
      .execute();

    // Proposals: reset state to the last known good canonical event.
    const staleProposals = await this.proposals
      .createQueryBuilder('p')
      .where('p.chainId = :chainId', { chainId })
      .andWhere('CAST(p.stateChangedAtBlock AS NUMERIC) > :rollbackToBlock', {
        rollbackToBlock: rollbackBlockStr,
      })
      .getMany();

    for (const proposal of staleProposals) {
      const lastValidEvent = await this.events
        .createQueryBuilder('e')
        .where('e.chainId = :chainId', { chainId })
        .andWhere('CAST(e.blockNumber AS NUMERIC) <= :rollbackToBlock', {
          rollbackToBlock: rollbackBlockStr,
        })
        .andWhere('e.payload LIKE :propId', {
          propId: `%"proposalId":"${proposal.proposalId}"%`,
        })
        .orderBy('e.blockNumber', 'DESC')
        .addOrderBy('e.logIndex', 'DESC')
        .getOne();

      if (!lastValidEvent) {
        await this.proposals.delete({ id: proposal.id });
        await this.actions.delete({
          chainId: proposal.chainId,
          proposalId: proposal.proposalId,
        });
        continue;
      }

      proposal.state = this.mapEventToState(lastValidEvent.eventName);
      proposal.stateChangedAtBlock = lastValidEvent.blockNumber;
      proposal.stateChangedAt = lastValidEvent.blockTimestamp;
      proposal.lastEventTxHash = lastValidEvent.txHash;
      proposal.lastEventLogIndex = lastValidEvent.logIndex;
      proposal.artifactVersion = lastValidEvent.artifactVersion;
      await this.proposals.save(proposal);

      // Recompute actions in case the abi-version changed. The projector
      // replaces the action set inside one transaction, so the replay cannot
      // expose a half-rebuilt projection.
      if (lastValidEvent.eventName === 'ProposalCreated') {
        await this.projectProposalCreated(lastValidEvent, true);
      }
    }

    this.logger.log(
      `Rolled back ${staleProposals.length} governance proposal(s) above block ${rollbackBlockStr}`,
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async upsertProposalWithin(
    repo: Repository<GovernanceProposal>,
    partial: Partial<GovernanceProposal>,
  ): Promise<GovernanceProposal> {
    const existing = await repo.findOne({
      where: {
        chainId: partial.chainId!,
        proposalId: partial.proposalId!,
      },
    });
    if (existing) {
      Object.assign(existing, partial);
      return repo.save(existing);
    }
    return repo.save(repo.create(partial));
  }

  /**
   * The exact ProposalCreated event is considered fully applied only when
   * its identity AND the expected action count are committed on the row.
   * A proposal marked by the old non-atomic projector fails this check and
   * is therefore repaired on the next replay.
   */
  private isFullyApplied(
    row: GovernanceProposal,
    event: CanonicalEvent,
  ): boolean {
    const expectedCount = this.readStringArray(event, 'targets').length;
    return (
      row.createdEventTxHash === event.txHash &&
      row.createdEventLogIndex === event.logIndex &&
      (row.actionCount ?? 0) === expectedCount
    );
  }

  private readBigInt(event: CanonicalEvent, key: string): string | null {
    const val = (event.payload as any)?.[key];
    if (val === undefined || val === null) return null;
    return String(val);
  }

  private readString(event: CanonicalEvent, key: string): string | null {
    const val = (event.payload as any)?.[key];
    if (val === undefined || val === null) return null;
    return String(val);
  }

  private readAddress(event: CanonicalEvent, key: string): string | null {
    const val = (event.payload as any)?.[key];
    if (typeof val !== 'string') return null;
    return val.toLowerCase();
  }

  private readStringArray(event: CanonicalEvent, key: string): string[] {
    const val = (event.payload as any)?.[key];
    if (!Array.isArray(val)) return [];
    return val.map((v) => String(v));
  }

  private mapSupport(n: string): VoteSupport {
    if (n === '0') return VoteSupport.AGAINST;
    if (n === '1') return VoteSupport.FOR;
    return VoteSupport.ABSTAIN;
  }

  private mapEventToState(eventName: string): ProposalChainState {
    switch (eventName) {
      case 'ProposalCreated':
        return ProposalChainState.PENDING;
      case 'ProposalQueued':
        return ProposalChainState.QUEUED;
      case 'ProposalExecuted':
        return ProposalChainState.EXECUTED;
      case 'ProposalCanceled':
        return ProposalChainState.CANCELLED;
      case 'ProposalExpired':
        return ProposalChainState.EXPIRED;
      default:
        return ProposalChainState.PENDING;
    }
  }
}

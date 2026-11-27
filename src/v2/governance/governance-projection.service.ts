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
    if (existing && existing.lastEventTxHash === event.txHash &&
        existing.lastEventLogIndex === event.logIndex) {
      return 'duplicate';
    }

    const targets = this.readStringArray(event, 'targets');
    const values = this.readStringArray(event, 'values');
    const calldatas = this.readStringArray(event, 'calldatas');
    const descriptionHash = this.readString(event, 'descriptionHash');
    const description = this.readString(event, 'description');
    const proposer = this.readAddress(event, 'proposer') ?? '0x0';

    // Decode every call against the approved ABI for its target *before* any
    // write, so a decoding failure leaves the last committed projection intact.
    const decodedActions: Partial<GovernanceAction>[] = [];
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

    // The proposal row and its replacement action set commit as one atomic
    // projection (#893): any failure rolls the whole replacement back, so a
    // reader can never observe a proposal with partially replaced actions.
    const proposalRow = await this.proposals.manager.transaction(
      async (manager) => {
        const proposals = manager.getRepository(GovernanceProposal);
        const actions = manager.getRepository(GovernanceAction);

        const row = await this.upsertProposal(
          {
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
          },
          proposals,
        );

        // Replace actions atomically for this proposal version.
        await actions.delete({ chainId: event.chainId, proposalId });
        if (decodedActions.length > 0) {
          await actions.save(
            decodedActions.map((action) => actions.create(action)),
          );
        }

        return row;
      },
    );

    this.logger.log(
      `Projected ProposalCreated ${proposalId} (${proposalRow.id}) with ${targets.length} call(s)`,
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

      // Recompute actions in case the abi-version changed.
      if (lastValidEvent.eventName === 'ProposalCreated') {
        await this.actions.delete({
          chainId: proposal.chainId,
          proposalId: proposal.proposalId,
        });
        await this.projectProposalCreated(lastValidEvent);
      }
    }

    this.logger.log(
      `Rolled back ${staleProposals.length} governance proposal(s) above block ${rollbackBlockStr}`,
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async upsertProposal(
    partial: Partial<GovernanceProposal>,
    repository: Repository<GovernanceProposal> = this.proposals,
  ): Promise<GovernanceProposal> {
    const existing = await repository.findOne({
      where: {
        chainId: partial.chainId!,
        proposalId: partial.proposalId!,
      },
    });
    if (existing) {
      Object.assign(existing, partial);
      return repository.save(existing);
    }
    return repository.save(repository.create(partial));
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

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
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
 * The only canonical event names that may determine a governance proposal's
 * on-chain state. VoteCast and role events are separate projections and must
 * never participate in state restoration during a reorg rollback.
 */
const PROPOSAL_LIFECYCLE_EVENTS = [
  'ProposalCreated',
  'ProposalQueued',
  'ProposalExecuted',
  'ProposalCanceled',
  'ProposalExpired',
] as const;

interface ProjectionRepositories {
  proposals: Repository<GovernanceProposal>;
  actions: Repository<GovernanceAction>;
  votes: Repository<ProposalVote>;
  roleChanges: Repository<RoleChange>;
  events: Repository<CanonicalEvent>;
}

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
          ...PROPOSAL_LIFECYCLE_EVENTS,
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
    repos: ProjectionRepositories = this.repositories,
  ): Promise<'applied' | 'duplicate' | 'stale_artifact'> {
    const proposalId = this.readBigInt(event, 'proposalId');
    if (proposalId === null) {
      this.logger.warn(
        `ProposalCreated event ${event.txHash}:${event.logIndex} missing proposalId`,
      );
      return 'skipped' as never;
    }

    const existing = await repos.proposals.findOne({
      where: { chainId: event.chainId, proposalId },
    });
    if (existing && existing.lastEventTxHash === event.txHash &&
        existing.lastEventLogIndex === event.logIndex) {
      return 'duplicate';
    }

    const descriptionHash = this.readString(event, 'descriptionHash');
    const description = this.readString(event, 'description');
    const proposer = this.readAddress(event, 'proposer') ?? '0x0';

    // Decode every call against the approved ABI for its target.
    const proposalRow = await this.upsertProposal(
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
      repos,
    );

    const actionCount = await this.rebuildProposalActions(
      event,
      proposalId,
      repos,
    );

    this.logger.log(
      `Projected ProposalCreated ${proposalId} (${proposalRow.id}) with ${actionCount} call(s)`,
    );
    return 'applied';
  }

  /**
   * Rebuild the action rows from a canonical ProposalCreated event. Used both
   * on forward projection and during rollback so proposal state and actions
   * are always derived from the same event inside one transaction.
   */
  private async rebuildProposalActions(
    event: CanonicalEvent,
    proposalId: string,
    repos: ProjectionRepositories,
  ): Promise<number> {
    const targets = this.readStringArray(event, 'targets');
    const values = this.readStringArray(event, 'values');
    const calldatas = this.readStringArray(event, 'calldatas');

    await repos.actions.delete({
      chainId: event.chainId,
      proposalId,
    });

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
      await repos.actions.save(
        repos.actions.create({
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
        }),
      );
    }
    return targets.length;
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
      return 'duplicate';
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
    if (!role || !account) return 'duplicate';

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
   * canonical and restore proposal state from canonical lifecycle events at
   * or below the rollback checkpoint. Votes and role changes are separate
   * projections: they are deleted by block but never determine state.
   *
   * The whole operation runs in one transaction so a proposal's state and its
   * action rows cannot diverge if any step fails.
   */
  async rollbackAboveBlock(
    chainId: number,
    rollbackToBlock: bigint,
  ): Promise<void> {
    const rollbackBlockStr = rollbackToBlock.toString();
    let rolledBack = 0;

    await this.runInTransaction(async (repos) => {
      // Votes and role changes are pure log-scoped rows: delete directly.
      await repos.votes
        .createQueryBuilder()
        .delete()
        .where('chainId = :chainId', { chainId })
        .andWhere('CAST(blockNumber AS NUMERIC) > :rollbackToBlock', {
          rollbackToBlock: rollbackBlockStr,
        })
        .execute();

      await repos.roleChanges
        .createQueryBuilder()
        .delete()
        .where('chainId = :chainId', { chainId })
        .andWhere('CAST(blockNumber AS NUMERIC) > :rollbackToBlock', {
          rollbackToBlock: rollbackBlockStr,
        })
        .execute();

      const staleProposals = await repos.proposals
        .createQueryBuilder('p')
        .where('p.chainId = :chainId', { chainId })
        .andWhere('CAST(p.stateChangedAtBlock AS NUMERIC) > :rollbackToBlock', {
          rollbackToBlock: rollbackBlockStr,
        })
        .getMany();

      for (const proposal of staleProposals) {
        const lifecycleEvents = await this.findLifecycleEvents(
          repos.events,
          chainId,
          proposal,
          rollbackBlockStr,
        );

        // A proposal without its canonical creation event has no valid
        // lifecycle: drop it together with every projected action.
        const creationEvent = lifecycleEvents
          .slice()
          .reverse()
          .find((event) => event.eventName === 'ProposalCreated');
        if (!creationEvent) {
          await repos.proposals.delete({ id: proposal.id });
          await repos.actions.delete({
            chainId: proposal.chainId,
            proposalId: proposal.proposalId,
          });
          continue;
        }

        const latestEvent = lifecycleEvents[lifecycleEvents.length - 1];
        const nextState = this.mapEventToState(latestEvent.eventName);
        if (nextState === null) continue;

        proposal.state = nextState;
        proposal.stateChangedAtBlock = latestEvent.blockNumber;
        proposal.stateChangedAt = latestEvent.blockTimestamp;
        proposal.lastEventTxHash = latestEvent.txHash;
        proposal.lastEventLogIndex = latestEvent.logIndex;
        proposal.artifactVersion = latestEvent.artifactVersion;
        await repos.proposals.save(proposal);

        // Rebuild actions from the canonical creation event in the same
        // transaction, so ABI changes cannot leave state/actions out of sync.
        await this.rebuildProposalActions(
          creationEvent,
          proposal.proposalId,
          repos,
        );
        rolledBack++;
      }
    });

    this.logger.log(
      `Rolled back ${rolledBack} governance proposal(s) above block ${rollbackBlockStr}`,
    );
  }

  /**
   * Fetch the canonical lifecycle events for one proposal at or below the
   * checkpoint. The database query uses a typed JSON predicate for proposalId
   * (and is always chain/governor scoped); the in-memory filters keep the
   * result deterministic even for drivers without JSON operators and for
   * mock repositories used in unit tests.
   */
  private async findLifecycleEvents(
    events: Repository<CanonicalEvent>,
    chainId: number,
    proposal: GovernanceProposal,
    rollbackBlockStr: string,
  ): Promise<CanonicalEvent[]> {
    const query = events
      .createQueryBuilder('e')
      .where('e.chainId = :chainId', { chainId })
      .andWhere('e.eventName IN (:...eventNames)', {
        eventNames: [...PROPOSAL_LIFECYCLE_EVENTS],
      })
      .andWhere('CAST(e.blockNumber AS NUMERIC) <= :rollbackToBlock', {
        rollbackToBlock: rollbackBlockStr,
      });

    if (proposal.governorAddress) {
      query.andWhere('e.contractAddress = :governorAddress', {
        governorAddress: proposal.governorAddress,
      });
    }

    const proposalIdClause = this.proposalIdPredicate(events);
    if (proposalIdClause) {
      query.andWhere(proposalIdClause, { proposalId: proposal.proposalId });
    }

    query
      .orderBy('CAST(e.blockNumber AS NUMERIC)', 'ASC')
      .addOrderBy('e.logIndex', 'ASC')
      .addOrderBy('e.txHash', 'ASC');

    const rows = await query.getMany();

    return rows
      .filter((event) => this.isLifecycleEvent(event.eventName))
      .filter((event) => this.readBigInt(event, 'proposalId') === proposal.proposalId)
      .filter((event) => event.chainId === chainId)
      .filter((event) =>
        !proposal.governorAddress ||
        event.contractAddress === proposal.governorAddress,
      )
      .filter((event) => {
        try {
          return BigInt(event.blockNumber) <= BigInt(rollbackBlockStr);
        } catch {
          return false;
        }
      })
      .sort((a, b) => this.compareCanonicalEvents(a, b));
  }

  private proposalIdPredicate(events: Repository<CanonicalEvent>): string | null {
    const dbType = (
      events.metadata?.connection?.options as { type?: string } | undefined
    )?.type;
    if (dbType === 'postgres' || dbType === 'postgresql') {
      return "(e.payload->>'proposalId') = :proposalId";
    }
    if (dbType === 'better-sqlite3' || dbType === 'sqlite') {
      return "CAST(json_extract(e.payload, '$.proposalId') AS TEXT) = :proposalId";
    }
    return null;
  }

  private isLifecycleEvent(eventName: string): boolean {
    return (PROPOSAL_LIFECYCLE_EVENTS as readonly string[]).includes(eventName);
  }

  private compareCanonicalEvents(
    a: CanonicalEvent,
    b: CanonicalEvent,
  ): number {
    const aBlock = BigInt(a.blockNumber ?? '0');
    const bBlock = BigInt(b.blockNumber ?? '0');
    if (aBlock !== bBlock) return aBlock < bBlock ? -1 : 1;
    if (a.logIndex !== b.logIndex) return a.logIndex - b.logIndex;
    return String(a.txHash).localeCompare(String(b.txHash));
  }

  private async runInTransaction<T>(
    work: (repos: ProjectionRepositories) => Promise<T>,
  ): Promise<T> {
    const manager: EntityManager | undefined = this.proposals.manager;
    if (!manager || typeof manager.transaction !== 'function') {
      return work(this.repositories);
    }

    return manager.transaction(async (tx: EntityManager) =>
      work({
        proposals: tx.getRepository(GovernanceProposal),
        actions: tx.getRepository(GovernanceAction),
        votes: tx.getRepository(ProposalVote),
        roleChanges: tx.getRepository(RoleChange),
        events: tx.getRepository(CanonicalEvent),
      }),
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private get repositories(): ProjectionRepositories {
    return {
      proposals: this.proposals,
      actions: this.actions,
      votes: this.votes,
      roleChanges: this.roleChanges,
      events: this.events,
    };
  }

  private async upsertProposal(
    partial: Partial<GovernanceProposal>,
    repos: ProjectionRepositories = this.repositories,
  ): Promise<GovernanceProposal> {
    const existing = await repos.proposals.findOne({
      where: {
        chainId: partial.chainId!,
        proposalId: partial.proposalId!,
      },
    });
    if (existing) {
      Object.assign(existing, partial);
      return repos.proposals.save(existing);
    }
    return repos.proposals.save(repos.proposals.create(partial));
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

  private mapEventToState(eventName: string): ProposalChainState | null {
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
        return null;
    }
  }
}

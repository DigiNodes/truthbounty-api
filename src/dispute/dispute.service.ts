import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  Dispute,
  DisputeStatus,
  DisputeTrigger,
  DisputeOutcome,
  DisputeRecordKind,
  DisputeDataState,
} from './entities/dispute.entity';
import {
  CanonicalEventRef,
  DisputeEvidenceService,
  DISPUTE_TERMINAL_EVENTS,
} from './canonical-dispute-evidence.service';
import { CanonicalEvent } from '../v2/events/entities/canonical-event.entity';

// ─── Configuration ────────────────────────────────────────────────────────────

export interface DisputeConfig {
  /** Confidence score below which a claim auto-triggers a dispute (0–1). */
  LOW_CONFIDENCE_THRESHOLD: number;
  /** Minority opposition ratio at or above which a dispute is triggered (0–1). */
  MINORITY_OPPOSITION_THRESHOLD: number;
  /** Hours after creation before an open/reviewing workflow record needs attention. */
  MAX_DISPUTE_DURATION_HOURS: number;
  /** Hours before a second workflow record can be raised on the same claim. */
  DISPUTE_COOLDOWN_HOURS: number;
}

export const DEFAULT_CONFIG: DisputeConfig = {
  LOW_CONFIDENCE_THRESHOLD: 0.6,
  MINORITY_OPPOSITION_THRESHOLD: 0.3,
  MAX_DISPUTE_DURATION_HOURS: 72,
  DISPUTE_COOLDOWN_HOURS: 24,
};

// ─── Commands (never carry protocol-authoritative fields) ─────────────────────

export interface CreateDisputeCommand {
  claimId: string;
  principal: string;
  canonicalEvent?: CanonicalEventRef;
  metadata?: Record<string, unknown>;
}

export interface ProjectOutcomeCommand {
  disputeId: string;
  canonicalEvent: CanonicalEventRef;
  metadata?: Record<string, unknown>;
}

export interface TriageCommand {
  disputeId: string;
  principal: string;
  reason?: string;
  note?: string;
  metadata?: Record<string, unknown>;
}

export interface FindAllDisputesDto {
  status?: DisputeStatus;
  trigger?: DisputeTrigger;
  claimId?: string;
  limit?: number;
  offset?: number;
}

export interface TriggerCheckResult {
  shouldDispute: boolean;
  trigger?: DisputeTrigger;
  reason?: string;
}

export interface PaginatedDisputes {
  items: Dispute[];
  total: number;
  limit: number;
  offset: number;
}

const RESOLVABLE_STATUSES: DisputeStatus[] = [
  DisputeStatus.OPEN,
  DisputeStatus.REVIEWING,
];
const PRINCIPAL_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Legacy dispute workflow service.
 *
 * Protocol-authoritative terminal fields (`status` RESOLVED/EXPIRED, `outcome`,
 * `finalConfidence`, provenance) are never written from an HTTP request. They
 * are projections of finalized canonical DisputeResolved/DisputeExpired logs,
 * validated by DisputeEvidenceService. Moderator endpoints only append
 * explicitly non-authoritative triage metadata. The initiator is always the
 * verified JWT principal, and trigger/confidence are derived from the raised
 * canonical event rather than from client input.
 */
@Injectable()
export class DisputeService {
  private readonly logger = new Logger(DisputeService.name);
  private readonly config: DisputeConfig;

  constructor(
    @InjectRepository(Dispute)
    private readonly disputeRepository: Repository<Dispute>,
    @InjectRepository(CanonicalEvent)
    private readonly canonicalEvents: Repository<CanonicalEvent>,
    private readonly evidence: DisputeEvidenceService,
    @Optional() config?: Partial<DisputeConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Trigger evaluation (informational, server-side only) ───────────────

  shouldTriggerDispute(
    confidence: number,
    minorityOpposition: number,
  ): TriggerCheckResult {
    this.validateConfidence(confidence, 'confidence');
    this.validateConfidence(minorityOpposition, 'minorityOpposition');

    if (confidence < this.config.LOW_CONFIDENCE_THRESHOLD) {
      return {
        shouldDispute: true,
        trigger: DisputeTrigger.LOW_CONFIDENCE,
        reason: `Confidence ${confidence.toFixed(4)} is below threshold ${this.config.LOW_CONFIDENCE_THRESHOLD}`,
      };
    }

    if (minorityOpposition >= this.config.MINORITY_OPPOSITION_THRESHOLD) {
      return {
        shouldDispute: true,
        trigger: DisputeTrigger.MINORITY_OPPOSITION,
        reason: `Minority opposition ${minorityOpposition.toFixed(4)} meets threshold ${this.config.MINORITY_OPPOSITION_THRESHOLD}`,
      };
    }

    return { shouldDispute: false };
  }

  // ─── Create ──────────────────────────────────────────────────────────────

  async createDispute(command: CreateDisputeCommand): Promise<Dispute> {
    const principal = this.assertPrincipal(command.principal);
    const raised = command.canonicalEvent
      ? await this.evidence.assertDisputeRaised(
          command.canonicalEvent,
          principal,
        )
      : null;

    if (
      raised &&
      command.claimId &&
      command.claimId.trim() !== raised.claimId
    ) {
      throw new BadRequestException('CLAIM_ID_MISMATCH');
    }

    const claimId = raised?.claimId ?? command.claimId;
    if (typeof claimId !== 'string' || claimId.trim() === '') {
      throw new BadRequestException('CLAIM_ID_REQUIRED');
    }

    if (raised) {
      const duplicate = await this.disputeRepository.findOne({
        where: {
          chainId: raised.chainId,
          eventTxHash: raised.txHash,
          eventLogIndex: raised.logIndex,
        },
      });
      if (duplicate) {
        throw new ConflictException('CANONICAL_EVENT_ALREADY_RECORDED');
      }
    }

    const [activeDispute, recentDispute] = await Promise.all([
      this.disputeRepository.findOne({
        where: { claimId, status: DisputeStatus.OPEN },
      }),
      this.disputeRepository
        .createQueryBuilder('d')
        .where('d.claimId = :claimId', { claimId })
        .andWhere('d.createdAt > :cooldownTime', {
          cooldownTime: this.hoursAgo(this.config.DISPUTE_COOLDOWN_HOURS),
        })
        .orderBy('d.createdAt', 'DESC')
        .getOne(),
    ]);

    if (activeDispute) {
      throw new ConflictException(
        `An open dispute already exists for claim ${claimId} (dispute id: ${activeDispute.id})`,
      );
    }
    if (recentDispute) {
      const elapsed = Date.now() - recentDispute.createdAt.getTime();
      const remainingHours = (
        this.config.DISPUTE_COOLDOWN_HOURS -
        elapsed / 3_600_000
      ).toFixed(1);
      throw new BadRequestException(
        `Dispute cooldown active for claim ${claimId}. ${remainingHours}h remaining.`,
      );
    }

    const raiseProvenance = raised
      ? {
          chainId: raised.chainId,
          deploymentAddress: raised.deploymentAddress,
          artifactVersion: raised.artifactVersion,
          canonicalClaimId: raised.claimId,
          originalRoundId: raised.roundId,
          eventTxHash: raised.txHash,
          eventLogIndex: raised.logIndex,
          eventBlockNumber: raised.blockNumber,
        }
      : {};

    const dispute = this.disputeRepository.create({
      claimId,
      trigger: raised?.trigger ?? DisputeTrigger.MANUAL,
      originalConfidence: raised?.reportedConfidence ?? 0,
      initiatorId: principal,
      status: DisputeStatus.OPEN,
      recordKind: raised
        ? DisputeRecordKind.CANONICAL_PROJECTION
        : DisputeRecordKind.LEGACY_WORKFLOW,
      dataState: raised
        ? DisputeDataState.FINALIZED
        : DisputeDataState.LOCAL_WORKFLOW,
      ...raiseProvenance,
      metadata: {
        ...(command.metadata ?? {}),
        ...(raised
          ? {
              source: 'DisputeRaised',
              canonicalRaise: {
                chainId: raised.chainId,
                deploymentAddress: raised.deploymentAddress,
                artifactVersion: raised.artifactVersion,
                txHash: raised.txHash,
                logIndex: raised.logIndex,
                blockNumber: raised.blockNumber,
                claimId: raised.claimId,
                roundId: raised.roundId,
              },
              bondAsset: raised.bondAsset,
              bondAmount: raised.bondAmount,
            }
          : {
              source: 'LEGACY_WORKFLOW',
              nonAuthoritative: true,
            }),
      },
    });

    const saved = await this.disputeRepository.save(dispute);
    this.logger.log(
      `Dispute ${saved.id} created for claim ${claimId} by ${principal} — ` +
        `kind=${saved.recordKind}, state=${saved.dataState}`,
    );
    return saved;
  }

  /** Non-authoritative workflow label. Never a protocol outcome. */
  async startReview(disputeId: string): Promise<Dispute> {
    const dispute = await this.findDisputeOrThrow(disputeId);
    this.assertStatus(dispute, [DisputeStatus.OPEN], 'start review on');

    dispute.status = DisputeStatus.REVIEWING;
    dispute.reviewStartedAt = new Date();

    const saved = await this.disputeRepository.save(dispute);
    this.logger.log(`Dispute ${disputeId} moved to REVIEWING (workflow only)`);
    return saved;
  }

  // ─── Canonical terminal projections ─────────────────────────────────────

  /**
   * The only path that may write a terminal protocol outcome. The caller
   * supplies a log pointer; outcome, confidence, actor and provenance are
   * re-derived from a finalized canonical event.
   */
  async projectOutcome(command: ProjectOutcomeCommand): Promise<Dispute> {
    const dispute = await this.findDisputeOrThrow(command.disputeId);
    this.assertProjectable(dispute);

    const evidence = await this.evidence.assertDisputeTerminal(
      command.canonicalEvent,
      dispute.canonicalClaimId as string,
      dispute.originalRoundId as string,
    );

    const duplicate = await this.disputeRepository.findOne({
      where: {
        chainId: evidence.chainId,
        eventTxHash: evidence.txHash,
        eventLogIndex: evidence.logIndex,
      },
    });
    if (duplicate && duplicate.id !== dispute.id) {
      throw new ConflictException('CANONICAL_EVENT_ALREADY_RECORDED');
    }
    const alreadyProjected =
      duplicate?.eventTxHash === evidence.txHash &&
      duplicate?.eventLogIndex === evidence.logIndex;

    if (!alreadyProjected) {
      this.assertStatus(dispute, RESOLVABLE_STATUSES, 'project outcome onto');
    }

    const raise = (dispute.metadata?.canonicalRaise ?? {}) as Record<
      string,
      unknown
    >;
    const applied = this.applyTerminalEvidence(dispute, evidence, raise);
    if (command.metadata) {
      applied.metadata = { ...applied.metadata, ...command.metadata };
    }

    const saved = await this.disputeRepository.save(applied);
    this.logger.log(
      `Projected ${evidence.terminalEventName} ${evidence.txHash}:${evidence.logIndex} onto ${dispute.id}`,
    );
    return saved;
  }

  /** Rebuild a projection deterministically from canonical history. */
  async replayProjection(disputeId: string): Promise<Dispute> {
    const dispute = await this.findDisputeOrThrow(disputeId);
    if (dispute.recordKind !== DisputeRecordKind.CANONICAL_PROJECTION) {
      return dispute;
    }

    const claimId = dispute.canonicalClaimId;
    const roundId = dispute.originalRoundId;
    if (!claimId || !roundId) return dispute;

    const candidates = await this.canonicalEvents.find({
      where: {
        claimId,
        eventName: In([...DISPUTE_TERMINAL_EVENTS]),
      },
      order: { blockNumber: 'DESC', logIndex: 'DESC' },
    });

    const raise = (dispute.metadata?.canonicalRaise ?? {}) as Record<
      string,
      unknown
    >;
    let rebuilt = false;

    for (const candidate of candidates) {
      if (candidate.roundId && candidate.roundId !== roundId) continue;
      try {
        const evidence = await this.evidence.assertDisputeTerminal(
          {
            chainId: candidate.chainId,
            txHash: candidate.txHash,
            logIndex: candidate.logIndex,
          },
          claimId,
          roundId,
        );
        this.applyTerminalEvidence(dispute, evidence, raise);
        rebuilt = true;
        break;
      } catch (error) {
        if (!(error instanceof BadRequestException)) throw error;
      }
    }

    if (!rebuilt) {
      this.clearTerminalState(dispute, raise);
    }

    const saved = await this.disputeRepository.save(dispute);
    this.logger.log(
      `Replayed dispute ${dispute.id}: terminal=${rebuilt}, dataState=${saved.dataState}`,
    );
    return saved;
  }

  /**
   * Deterministic reorg handling: drop projections backed by events above the
   * new canonical head. A reorged terminal event restores the OPEN workflow
   * state; a reorged raising event demotes the row to a legacy workflow record.
   */
  async reconcileReorg(
    chainId: number,
    rollbackToBlock: bigint,
  ): Promise<{ terminalCleared: number; disputesDemoted: number }> {
    const rollbackBlock = rollbackToBlock.toString();
    const stale = await this.disputeRepository
      .createQueryBuilder('d')
      .where('d.chainId = :chainId', { chainId })
      .andWhere('CAST(d.eventBlockNumber AS NUMERIC) > :rollbackBlock', {
        rollbackBlock,
      })
      .getMany();

    let terminalCleared = 0;
    let disputesDemoted = 0;

    for (const dispute of stale) {
      const raise = (dispute.metadata?.canonicalRaise ?? {}) as Record<
        string,
        unknown
      >;
      const raiseBlockValue = raise.blockNumber;
      const raiseBlock =
        typeof raiseBlockValue === 'string' ||
        typeof raiseBlockValue === 'number'
          ? String(raiseBlockValue)
          : '';
      const isRaiseReorged =
        raiseBlock !== '' && BigInt(raiseBlock) > rollbackToBlock;

      if (isRaiseReorged) {
        this.demoteToWorkflow(dispute);
        disputesDemoted += 1;
      } else {
        this.clearTerminalState(dispute, raise);
        terminalCleared += 1;
      }
      await this.disputeRepository.save(dispute);
    }

    this.logger.warn(
      `Reorg reconciliation chain=${chainId} block=${rollbackBlock}: ` +
        `terminalCleared=${terminalCleared}, disputesDemoted=${disputesDemoted}`,
    );
    return { terminalCleared, disputesDemoted };
  }

  // ─── Non-authoritative moderator triage ──────────────────────────────────

  /**
   * Replaces the former resolve/reject writes. Triage is review metadata only:
   * it never touches terminal status, outcome, confidence or resolvedAt.
   */
  async recordTriage(command: TriageCommand): Promise<Dispute> {
    const principal = this.assertPrincipal(command.principal);
    const dispute = await this.findDisputeOrThrow(command.disputeId);

    const entry = {
      by: principal,
      at: new Date().toISOString(),
      ...(command.reason ? { reason: command.reason } : {}),
      ...(command.note ? { note: command.note } : {}),
      ...(command.metadata ?? {}),
      nonAuthoritative: true,
    };
    const existingTriage = Array.isArray(dispute.metadata?.reviewTriage)
      ? (dispute.metadata.reviewTriage as Record<string, unknown>[])
      : [];
    dispute.metadata = {
      ...dispute.metadata,
      reviewTriage: [...existingTriage, entry],
    };

    const saved = await this.disputeRepository.save(dispute);
    this.logger.log(
      `Non-authoritative triage recorded on ${dispute.id} by ${principal}`,
    );
    return saved;
  }

  // ─── Queries ─────────────────────────────────────────────────────────────

  async getDisputeByClaimId(claimId: string): Promise<Dispute | null> {
    return this.disputeRepository.findOne({
      where: { claimId },
      order: { createdAt: 'DESC' },
    });
  }

  async getDisputeHistoryForClaim(claimId: string): Promise<Dispute[]> {
    return this.disputeRepository.find({
      where: { claimId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Workflow records that have been open past the configured duration. This
   * is an attention queue, not an expiry authority: the protocol deadline and
   * any terminal EXPIRED state come from a canonical DisputeExpired event.
   */
  async getExpiredDisputes(): Promise<Dispute[]> {
    return this.disputeRepository
      .createQueryBuilder('d')
      .where('d.status IN (:...statuses)', { statuses: RESOLVABLE_STATUSES })
      .andWhere('d.createdAt < :expiryTime', {
        expiryTime: this.hoursAgo(this.config.MAX_DISPUTE_DURATION_HOURS),
      })
      .getMany();
  }

  async findAll(dto: FindAllDisputesDto = {}): Promise<PaginatedDisputes> {
    const { status, trigger, claimId, limit = 50, offset = 0 } = dto;

    if (limit < 1 || limit > 200) {
      throw new BadRequestException('limit must be between 1 and 200');
    }

    const qb = this.disputeRepository
      .createQueryBuilder('d')
      .orderBy('d.createdAt', 'DESC')
      .skip(offset)
      .take(limit);

    if (status) qb.andWhere('d.status = :status', { status });
    if (trigger) qb.andWhere('d.trigger = :trigger', { trigger });
    if (claimId) qb.andWhere('d.claimId = :claimId', { claimId });

    const [items, total] = await qb.getManyAndCount();
    return { items, total, limit, offset };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private applyTerminalEvidence(
    dispute: Dispute,
    evidence: {
      chainId: number;
      deploymentAddress: string;
      artifactVersion: string;
      blockNumber: string;
      txHash: string;
      logIndex: number;
      occurredAt: Date | null;
      terminalEventName: string;
      outcome: DisputeOutcome | null;
      finalConfidence: number | null;
    },
    raise: Record<string, unknown>,
  ): Dispute {
    if (evidence.terminalEventName === 'DisputeExpired') {
      dispute.status = DisputeStatus.EXPIRED;
      dispute.outcome = null;
      dispute.finalConfidence = null;
    } else {
      dispute.status = DisputeStatus.RESOLVED;
      dispute.outcome = evidence.outcome;
      dispute.finalConfidence = evidence.finalConfidence ?? 0;
    }

    dispute.resolvedAt = evidence.occurredAt ?? new Date();
    dispute.recordKind = DisputeRecordKind.CANONICAL_PROJECTION;
    dispute.dataState = DisputeDataState.FINALIZED;
    dispute.chainId = evidence.chainId;
    dispute.deploymentAddress = evidence.deploymentAddress;
    dispute.artifactVersion = evidence.artifactVersion;
    dispute.eventTxHash = evidence.txHash;
    dispute.eventLogIndex = evidence.logIndex;
    dispute.eventBlockNumber = evidence.blockNumber;
    dispute.metadata = {
      ...dispute.metadata,
      canonicalRaise: raise,
      canonicalTerminal: {
        eventName: evidence.terminalEventName,
        txHash: evidence.txHash,
        logIndex: evidence.logIndex,
        blockNumber: evidence.blockNumber,
        artifactVersion: evidence.artifactVersion,
      },
      source: evidence.terminalEventName,
      nonAuthoritative: false,
    };
    return dispute;
  }

  private clearTerminalState(
    dispute: Dispute,
    raise: Record<string, unknown>,
  ): void {
    dispute.status = DisputeStatus.OPEN;
    dispute.outcome = null;
    dispute.finalConfidence = null;
    dispute.resolvedAt = null;
    dispute.chainId = raise.chainId ? Number(raise.chainId) : null;
    dispute.deploymentAddress =
      typeof raise.deploymentAddress === 'string'
        ? raise.deploymentAddress
        : null;
    dispute.artifactVersion =
      typeof raise.artifactVersion === 'string' ? raise.artifactVersion : null;
    dispute.eventTxHash =
      typeof raise.txHash === 'string' ? raise.txHash : null;
    dispute.eventLogIndex =
      typeof raise.logIndex === 'number' ? raise.logIndex : null;
    dispute.eventBlockNumber =
      typeof raise.blockNumber === 'string' ? raise.blockNumber : null;
    const metadata = { ...dispute.metadata, ...raise };
    delete metadata.canonicalTerminal;
    dispute.metadata = metadata;
  }

  private demoteToWorkflow(dispute: Dispute): void {
    this.clearTerminalState(dispute, {});
    dispute.recordKind = DisputeRecordKind.LEGACY_WORKFLOW;
    dispute.dataState = DisputeDataState.LOCAL_WORKFLOW;
    dispute.canonicalClaimId = null;
    dispute.originalRoundId = null;
    dispute.chainId = null;
    dispute.deploymentAddress = null;
    dispute.artifactVersion = null;
    dispute.eventTxHash = null;
    dispute.eventLogIndex = null;
    dispute.eventBlockNumber = null;
    const metadata = { ...dispute.metadata };
    delete metadata.canonicalRaise;
    delete metadata.canonicalTerminal;
    dispute.metadata = { ...metadata, nonAuthoritative: true };
  }

  private assertProjectable(dispute: Dispute): void {
    if (
      dispute.recordKind !== DisputeRecordKind.CANONICAL_PROJECTION ||
      !dispute.canonicalClaimId ||
      !dispute.originalRoundId
    ) {
      throw new BadRequestException('CANONICAL_DISPUTE_REQUIRED');
    }
  }

  private async findDisputeOrThrow(disputeId: string): Promise<Dispute> {
    const dispute = await this.disputeRepository.findOne({
      where: { id: disputeId },
    });
    if (!dispute) {
      throw new NotFoundException(`Dispute with ID ${disputeId} not found`);
    }
    return dispute;
  }

  private assertStatus(
    dispute: Dispute,
    allowed: DisputeStatus[],
    action: string,
  ): void {
    if (!allowed.includes(dispute.status)) {
      throw new BadRequestException(
        `Cannot ${action} dispute ${dispute.id}: current status is ${dispute.status}, expected one of [${allowed.join(', ')}]`,
      );
    }
  }

  private assertPrincipal(address: unknown): string {
    if (
      typeof address !== 'string' ||
      !PRINCIPAL_ADDRESS_PATTERN.test(address)
    ) {
      throw new BadRequestException('INVALID_VERIFIED_PRINCIPAL');
    }
    return address.toLowerCase();
  }

  private validateConfidence(value: number, field: string): void {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new BadRequestException(
        `${field} must be a finite number between 0 and 1, received ${value}`,
      );
    }
  }

  private hoursAgo(hours: number): Date {
    return new Date(Date.now() - hours * 3_600_000);
  }
}

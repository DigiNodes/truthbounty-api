import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  Dispute,
  DisputeStatus,
  DisputeTrigger,
  DisputeOutcome,
} from './entities/dispute.entity';

// ─── Configuration ────────────────────────────────────────────────────────────

export interface DisputeConfig {
  /** Confidence score below which a claim auto-triggers a dispute (0–1). */
  LOW_CONFIDENCE_THRESHOLD: number;
  /** Minority opposition ratio at or above which a dispute is triggered (0–1). */
  MINORITY_OPPOSITION_THRESHOLD: number;
  /** Hours after creation before an open/reviewing dispute is considered expired. */
  MAX_DISPUTE_DURATION_HOURS: number;
  /** Hours that must pass before a second dispute can be raised on the same claim. */
  DISPUTE_COOLDOWN_HOURS: number;
}

export const DEFAULT_CONFIG: DisputeConfig = {
  LOW_CONFIDENCE_THRESHOLD: 0.6,
  MINORITY_OPPOSITION_THRESHOLD: 0.3,
  MAX_DISPUTE_DURATION_HOURS: 72,
  DISPUTE_COOLDOWN_HOURS: 24,
};

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export interface CreateDisputeDto {
  claimId: string;
  trigger: DisputeTrigger;
  originalConfidence: number;
  initiatorId?: string;
  metadata?: Record<string, unknown>;
}

export interface ResolveDisputeDto {
  disputeId: string;
  outcome: DisputeOutcome;
  finalConfidence: number;
  metadata?: Record<string, unknown>;
}

export interface RejectDisputeDto {
  disputeId: string;
  reason: string;
  rejectedBy?: string;
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

// ─── Resolvable statuses ──────────────────────────────────────────────────────

const RESOLVABLE_STATUSES: DisputeStatus[] = [
  DisputeStatus.OPEN,
  DisputeStatus.REVIEWING,
];

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class DisputeService {
  private readonly logger = new Logger(DisputeService.name);
  private readonly config: DisputeConfig;

  constructor(
    @InjectRepository(Dispute)
    private readonly disputeRepository: Repository<Dispute>,
    private readonly dataSource: DataSource,
    config?: Partial<DisputeConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Trigger evaluation ──────────────────────────────────────────────────

  /**
   * Evaluate whether a claim's current scores warrant opening a dispute.
   *
   * Rules are checked in priority order — the first matching rule wins.
   * Returns a full explanation alongside the boolean so callers can log or
   * surface the reason without re-deriving it.
   */
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

  /**
   * Open a new dispute for a claim.
   *
   * Guards:
   * - Throws `ConflictException`    if an OPEN dispute already exists.
   * - Throws `BadRequestException`  if the cooldown window has not elapsed.
   * - Throws `BadRequestException`  if `originalConfidence` is outside [0, 1].
   */
  async createDispute(dto: CreateDisputeDto): Promise<Dispute> {
    const { claimId, trigger, originalConfidence, initiatorId, metadata } = dto;

    this.validateConfidence(originalConfidence, 'originalConfidence');

    // Single query covering both the open-duplicate check and the cooldown check
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
        this.config.DISPUTE_COOLDOWN_HOURS - elapsed / 3_600_000
      ).toFixed(1);
      throw new BadRequestException(
        `Dispute cooldown active for claim ${claimId}. ${remainingHours}h remaining.`,
      );
    }

    const dispute = this.disputeRepository.create({
      claimId,
      trigger,
      originalConfidence,
      initiatorId,
      metadata: metadata ?? {},
      status: DisputeStatus.OPEN,
    });

    const saved = await this.disputeRepository.save(dispute);
    this.logger.log(
      `Dispute ${saved.id} created for claim ${claimId} — trigger=${trigger}, confidence=${originalConfidence}`,
    );
    return saved;
  }

  // ─── Status transitions ──────────────────────────────────────────────────

  /**
   * Transition a dispute from OPEN → REVIEWING.
   * Stamps `reviewStartedAt` and persists atomically.
   */
  async startReview(disputeId: string): Promise<Dispute> {
    const dispute = await this.findDisputeOrThrow(disputeId);
    this.assertStatus(dispute, [DisputeStatus.OPEN], 'start review on');

    dispute.status = DisputeStatus.REVIEWING;
    dispute.reviewStartedAt = new Date();

    const saved = await this.disputeRepository.save(dispute);
    this.logger.log(`Dispute ${disputeId} moved to REVIEWING`);
    return saved;
  }

  /**
   * Resolve a dispute in OPEN or REVIEWING state.
   * Merges any additional metadata with the existing record.
   */
  async resolveDispute(dto: ResolveDisputeDto): Promise<Dispute> {
    const { disputeId, outcome, finalConfidence, metadata } = dto;

    this.validateConfidence(finalConfidence, 'finalConfidence');

    const dispute = await this.findDisputeOrThrow(disputeId);
    this.assertStatus(dispute, RESOLVABLE_STATUSES, 'resolve');

    dispute.status = DisputeStatus.RESOLVED;
    dispute.outcome = outcome;
    dispute.finalConfidence = finalConfidence;
    dispute.resolvedAt = new Date();

    if (metadata) {
      dispute.metadata = { ...dispute.metadata, ...metadata };
    }

    const saved = await this.disputeRepository.save(dispute);
    this.logger.log(
      `Dispute ${disputeId} resolved — outcome=${outcome}, finalConfidence=${finalConfidence}`,
    );
    return saved;
  }

  /**
   * Reject a dispute as spam or invalid.
   * Only OPEN disputes may be rejected; REVIEWING disputes must be resolved.
   */
  async rejectDispute(dto: RejectDisputeDto): Promise<Dispute> {
    const { disputeId, reason, rejectedBy } = dto;

    if (!reason?.trim()) {
      throw new BadRequestException('A rejection reason is required');
    }

    const dispute = await this.findDisputeOrThrow(disputeId);
    this.assertStatus(dispute, [DisputeStatus.OPEN], 'reject');

    dispute.status = DisputeStatus.REJECTED;
    dispute.resolvedAt = new Date();
    dispute.metadata = {
      ...dispute.metadata,
      rejectionReason: reason,
      ...(rejectedBy ? { rejectedBy } : {}),
    };

    const saved = await this.disputeRepository.save(dispute);
    this.logger.log(`Dispute ${disputeId} rejected — reason="${reason}"`);
    return saved;
  }

  /**
   * Expire a single dispute that has exceeded MAX_DISPUTE_DURATION_HOURS.
   * Wraps the update in a transaction to prevent double-expiry races.
   */
  async expireDispute(disputeId: string): Promise<Dispute> {
    return this.dataSource.transaction(async (manager) => {
      const dispute = await manager.findOne(Dispute, { where: { id: disputeId } });

      if (!dispute) throw new NotFoundException(`Dispute ${disputeId} not found`);

      if (!RESOLVABLE_STATUSES.includes(dispute.status)) {
        throw new BadRequestException(
          `Dispute ${disputeId} is in status ${dispute.status} and cannot be expired`,
        );
      }

      dispute.status = DisputeStatus.EXPIRED;
      dispute.resolvedAt = new Date();
      dispute.metadata = {
        ...dispute.metadata,
        expiredReason: `Exceeded ${this.config.MAX_DISPUTE_DURATION_HOURS}h maximum duration`,
      };

      const saved = await manager.save(dispute);
      this.logger.log(`Dispute ${disputeId} expired`);
      return saved;
    });
  }

  // ─── Queries ─────────────────────────────────────────────────────────────

  /**
   * Fetch the most recent dispute for a given claim.
   * Returns `null` when no dispute has ever been raised.
   */
  async getDisputeByClaimId(claimId: string): Promise<Dispute | null> {
    return this.disputeRepository.findOne({
      where: { claimId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Fetch all disputes for a claim, newest-first.
   */
  async getDisputeHistoryForClaim(claimId: string): Promise<Dispute[]> {
    return this.disputeRepository.find({
      where: { claimId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Return disputes whose OPEN/REVIEWING status has outlasted the configured
   * maximum duration. Intended for a scheduled expiry job.
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

  /**
   * Paginated, filtered dispute listing.
   * All filter fields are optional — omitting all returns the full set.
   */
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
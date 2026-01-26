import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Dispute, DisputeStatus, DisputeTrigger, DisputeOutcome } from './entities/dispute.entity';

interface DisputeConfig {
  LOW_CONFIDENCE_THRESHOLD: number; // e.g., 0.6
  MINORITY_OPPOSITION_THRESHOLD: number; // e.g., 0.3
  MAX_DISPUTE_DURATION_HOURS: number; // e.g., 72
  DISPUTE_COOLDOWN_HOURS: number; // e.g., 24
}

const DEFAULT_CONFIG: DisputeConfig = {
  LOW_CONFIDENCE_THRESHOLD: 0.6,
  MINORITY_OPPOSITION_THRESHOLD: 0.3,
  MAX_DISPUTE_DURATION_HOURS: 72,
  DISPUTE_COOLDOWN_HOURS: 24,
};

@Injectable()
export class DisputeService {
  constructor(
    @InjectRepository(Dispute)
    private readonly disputeRepository: Repository<Dispute>,
  ) {}

  /**
   * Check if claim should trigger dispute
   */
  shouldTriggerDispute(
    confidence: number,
    minorityOpposition: number,
  ): { shouldDispute: boolean; trigger?: DisputeTrigger } {
    if (confidence < DEFAULT_CONFIG.LOW_CONFIDENCE_THRESHOLD) {
      return { shouldDispute: true, trigger: DisputeTrigger.LOW_CONFIDENCE };
    }

    if (minorityOpposition >= DEFAULT_CONFIG.MINORITY_OPPOSITION_THRESHOLD) {
      return { shouldDispute: true, trigger: DisputeTrigger.MINORITY_OPPOSITION };
    }

    return { shouldDispute: false };
  }

  /**
   * Create dispute for a claim
   */
  async createDispute(
    claimId: string,
    trigger: DisputeTrigger,
    originalConfidence: number,
    initiatorId?: string,
    metadata?: Record<string, any>,
  ): Promise<Dispute> {
    // Check for existing active dispute
    const existingDispute = await this.disputeRepository.findOne({
      where: {
        claimId,
        status: DisputeStatus.OPEN,
      },
    });

    if (existingDispute) {
      throw new BadRequestException('Active dispute already exists for this claim');
    }

    // Check cooldown for spam prevention
    const recentDispute = await this.disputeRepository
      .createQueryBuilder('dispute')
      .where('dispute.claimId = :claimId', { claimId })
      .andWhere('dispute.createdAt > :cooldownTime', {
        cooldownTime: new Date(Date.now() - DEFAULT_CONFIG.DISPUTE_COOLDOWN_HOURS * 60 * 60 * 1000),
      })
      .getOne();

    if (recentDispute) {
      throw new BadRequestException('Dispute cooldown period not elapsed');
    }

    const dispute = this.disputeRepository.create({
      claimId,
      trigger,
      originalConfidence,
      initiatorId,
      metadata: metadata || {},
      status: DisputeStatus.OPEN,
    });

    return this.disputeRepository.save(dispute);
  }

  /**
   * Start review process
   */
  async startReview(disputeId: string): Promise<Dispute> {
    const dispute = await this.disputeRepository.findOne({
      where: { id: disputeId },
    });

    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }

    if (dispute.status !== DisputeStatus.OPEN) {
      throw new BadRequestException('Dispute is not in OPEN status');
    }

    dispute.status = DisputeStatus.REVIEWING;
    dispute.reviewStartedAt = new Date();

    return this.disputeRepository.save(dispute);
  }

  /**
   * Resolve dispute with outcome
   */
  async resolveDispute(
    disputeId: string,
    outcome: DisputeOutcome,
    finalConfidence: number,
    metadata?: Record<string, any>,
  ): Promise<Dispute> {
    const dispute = await this.disputeRepository.findOne({
      where: { id: disputeId },
    });

    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }

    if (![DisputeStatus.OPEN, DisputeStatus.REVIEWING].includes(dispute.status)) {
      throw new BadRequestException('Dispute cannot be resolved in current status');
    }

    dispute.status = DisputeStatus.RESOLVED;
    dispute.outcome = outcome;
    dispute.finalConfidence = finalConfidence;
    dispute.resolvedAt = new Date();
    
    if (metadata) {
      dispute.metadata = { ...dispute.metadata, ...metadata };
    }

    return this.disputeRepository.save(dispute);
  }

  /**
   * Reject dispute (spam/invalid)
   */
  async rejectDispute(disputeId: string, reason: string): Promise<Dispute> {
    const dispute = await this.disputeRepository.findOne({
      where: { id: disputeId },
    });

    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }

    if (dispute.status !== DisputeStatus.OPEN) {
      throw new BadRequestException('Only OPEN disputes can be rejected');
    }

    dispute.status = DisputeStatus.REJECTED;
    dispute.metadata = { ...dispute.metadata, rejectionReason: reason };
    dispute.resolvedAt = new Date();

    return this.disputeRepository.save(dispute);
  }

  /**
   * Get dispute by claim ID
   */
  async getDisputeByClaimId(claimId: string): Promise<Dispute | null> {
    return this.disputeRepository.findOne({
      where: { claimId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Check for expired disputes
   */
  async getExpiredDisputes(): Promise<Dispute[]> {
    const expiryTime = new Date(
      Date.now() - DEFAULT_CONFIG.MAX_DISPUTE_DURATION_HOURS * 60 * 60 * 1000,
    );

    return this.disputeRepository
      .createQueryBuilder('dispute')
      .where('dispute.status IN (:...statuses)', {
        statuses: [DisputeStatus.OPEN, DisputeStatus.REVIEWING],
      })
      .andWhere('dispute.createdAt < :expiryTime', { expiryTime })
      .getMany();
  }

  /**
   * Get all disputes with filters
   */
  async findAll(
    status?: DisputeStatus,
    trigger?: DisputeTrigger,
  ): Promise<Dispute[]> {
    const query = this.disputeRepository.createQueryBuilder('dispute');

    if (status) {
      query.andWhere('dispute.status = :status', { status });
    }

    if (trigger) {
      query.andWhere('dispute.trigger = :trigger', { trigger });
    }

    return query.orderBy('dispute.createdAt', 'DESC').getMany();
  }
}
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Claim } from '../../claims/entities/claim.entity';
import { Evidence } from '../../claims/entities/evidence.entity';

/**
 * Claim stakeholders resolved from canonical claim data.
 * 
 * Stakeholder categories:
 * - creator: User who created the claim
 * - verifiers: Users who submitted evidence
 * - commenters: Users who commented (if comments exist)
 * - watchers: Users explicitly following the claim (if feature exists)
 * - assignedVerifiers: Users assigned to verify (if assignment exists)
 */
export interface ClaimStakeholders {
  creator: string | null;
  verifiers: string[];
  commenters: string[];
  watchers: string[];
  assignedVerifiers: string[];
}

/**
 * ClaimStakeholderResolver
 * 
 * Resolves authorized stakeholders for claim lifecycle notifications.
 * Uses transaction-aware queries to ensure consistency with event publication.
 * 
 * Security:
 * - Never exposes cross-claim user data
 * - Respects user isolation boundaries
 * - Deduplicates recipients to prevent duplicate notifications
 * - Excludes actor from recipient list where policy requires
 */
@Injectable()
export class ClaimStakeholderResolver {
  private readonly logger = new Logger(ClaimStakeholderResolver.name);

  constructor(
    @InjectRepository(Claim)
    private claimRepository: Repository<Claim>,
    @InjectRepository(Evidence)
    private evidenceRepository: Repository<Evidence>,
  ) {}

  /**
   * Resolve all stakeholders for a claim.
   * Uses the provided EntityManager for transaction consistency.
   * 
   * @param claimId - The claim ID to resolve stakeholders for
   * @param manager - EntityManager from active transaction
   * @returns Stakeholder categories
   */
  async resolveStakeholders(
    claimId: string,
    manager: EntityManager,
  ): Promise<ClaimStakeholders> {
    try {
      // 1. Get claim with metadata
      const claim = await manager.findOne(Claim, {
        where: { id: claimId },
        select: ['id', 'metadata'],
      });

      if (!claim) {
        this.logger.warn(`Claim ${claimId} not found during stakeholder resolution`);
        return this.emptyStakeholders();
      }

      // 2. Extract creator from metadata
      // Note: Claims may store creator in metadata.creatorId or other field
      const creator = claim.metadata?.creatorId || 
                      claim.metadata?.submitterId ||
                      claim.metadata?.userId ||
                      null;

      // 3. Get verifiers from evidence submissions
      const evidences = await manager.find(Evidence, {
        where: { claimId },
        select: ['id', 'metadata'],
      });

      const verifiers = evidences
        .map(e => 
          e.metadata?.submittedBy || 
          e.metadata?.verifierId || 
          e.metadata?.userId
        )
        .filter((id): id is string => !!id && typeof id === 'string');

      // 4. TODO: Get commenters (if ClaimComment entity exists)
      // For now, return empty array
      const commenters: string[] = [];

      // 5. TODO: Get watchers (if ClaimWatch/Subscription feature exists)
      // For now, return empty array
      const watchers: string[] = [];

      // 6. TODO: Get assigned verifiers (if VerificationAssignment exists)
      // For now, return empty array
      const assignedVerifiers: string[] = [];

      return {
        creator,
        verifiers,
        commenters,
        watchers,
        assignedVerifiers,
      };
    } catch (error) {
      this.logger.error(
        `Failed to resolve stakeholders for claim ${claimId}: ${error.message}`,
        error.stack
      );
      // Fail-closed: return empty stakeholders on error
      return this.emptyStakeholders();
    }
  }

  /**
   * Get recipient list for claim-created event.
   * Policy: Notify creator only (they initiated the action).
   * 
   * @param claimId - The claim ID
   * @param creatorId - The user who created the claim
   * @param manager - EntityManager from active transaction
   * @returns Array of user IDs to notify
   */
  async getClaimCreatedRecipients(
    claimId: string,
    creatorId: string,
    manager: EntityManager,
  ): Promise<string[]> {
    // For claim-created, only the creator is notified
    // (This is confirmation of their own action)
    return [creatorId];
  }

  /**
   * Get recipient list for claim-updated event.
   * Policy: Notify all stakeholders except the actor who made the update.
   * 
   * @param claimId - The claim ID
   * @param actorId - The user who made the update (excluded from recipients)
   * @param manager - EntityManager from active transaction
   * @returns Array of user IDs to notify
   */
  async getClaimUpdatedRecipients(
    claimId: string,
    actorId: string,
    manager: EntityManager,
  ): Promise<string[]> {
    const stakeholders = await this.resolveStakeholders(claimId, manager);

    // Collect all stakeholders
    const allRecipients = [
      stakeholders.creator,
      ...stakeholders.verifiers,
      ...stakeholders.commenters,
      ...stakeholders.watchers,
      ...stakeholders.assignedVerifiers,
    ].filter((id): id is string => !!id && typeof id === 'string');

    // Deduplicate and exclude actor
    const uniqueRecipients = Array.from(new Set(allRecipients))
      .filter(id => id !== actorId);

    return uniqueRecipients;
  }

  /**
   * Get recipient list for claim-resolved event.
   * Policy: Notify all stakeholders (including creator).
   * 
   * @param claimId - The claim ID
   * @param manager - EntityManager from active transaction
   * @returns Array of user IDs to notify
   */
  async getClaimResolvedRecipients(
    claimId: string,
    manager: EntityManager,
  ): Promise<string[]> {
    const stakeholders = await this.resolveStakeholders(claimId, manager);

    const allRecipients = [
      stakeholders.creator,
      ...stakeholders.verifiers,
      ...stakeholders.commenters,
      ...stakeholders.watchers,
      ...stakeholders.assignedVerifiers,
    ].filter((id): id is string => !!id && typeof id === 'string');

    // Deduplicate
    return Array.from(new Set(allRecipients));
  }

  /**
   * Get recipient list for claim-archived event.
   * Policy: Notify all stakeholders.
   * 
   * @param claimId - The claim ID
   * @param manager - EntityManager from active transaction
   * @returns Array of user IDs to notify
   */
  async getClaimArchivedRecipients(
    claimId: string,
    manager: EntityManager,
  ): Promise<string[]> {
    // Same as resolved - all stakeholders
    return this.getClaimResolvedRecipients(claimId, manager);
  }

  /**
   * Helper: Return empty stakeholders object
   */
  private emptyStakeholders(): ClaimStakeholders {
    return {
      creator: null,
      verifiers: [],
      commenters: [],
      watchers: [],
      assignedVerifiers: [],
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { NotificationEventPublisher } from './notification-event-publisher.service';
import { EventType } from '../enums/event-type.enum';
import { PublishEventDto } from '../dto/publish-event.dto';
import { CanonicalEvent } from '../../v2/events/entities/canonical-event.entity';
import { User, UserRole } from '../../entities/user.entity';

/**
 * VerificationEventPublisher
 * 
 * Publishes notification events for verification-related protocol events.
 * 
 * Events:
 * - VERIFICATION_ASSIGNED: Verifier assigned to claim
 * - VERIFICATION_COMPLETED: Verification result submitted
 * - VERIFICATION_CONTESTED: Verification result disputed
 * 
 * Security constraints:
 * - Recipient resolution queries canonical events (authoritative state)
 * - Fails closed on missing, stale, or ambiguous state
 * - Self-notification is excluded (verifier doesn't receive their own completion)
 * - Deduplicates recipients before publishing
 * - Privacy-safe: no secrets, device tokens, or unnecessary PII in metadata
 */
@Injectable()
export class VerificationEventPublisher {
  private readonly logger = new Logger(VerificationEventPublisher.name);

  constructor(private eventPublisher: NotificationEventPublisher) {}

  /**
   * Publish verification assigned event
   * Notifies verifier they've been assigned
   */
  async publishVerificationAssigned(
    verificationId: string,
    verifierId: string,
    claimId: string,
    claimTitle: string,
    assignorId: string,
    manager: EntityManager,
  ): Promise<void> {
    const event: PublishEventDto = {
      eventType: EventType.VERIFICATION_ASSIGNED,
      aggregateId: verificationId,
      recipientIds: [verifierId],
      metadata: {
        verificationId,
        verifierId,
        claimId,
        claimTitle,
        assignorId,
        verificationUrl: `https://truthbounty.io/verifications/${verificationId}`,
      },
      sourceUserId: assignorId,
      tags: ['verification', 'assignment'],
    };

    await this.eventPublisher.publishEvent(event, manager);
    this.logger.log(`Published VERIFICATION_ASSIGNED for verification ${verificationId}`);
  }

  /**
   * Publish verification completed event
   * Notifies claim creator and other verifiers (excluding submitting verifier)
   */
  async publishVerificationCompleted(
    verificationId: string,
    verifierId: string,
    claimId: string,
    claimTitle: string,
    verdict: string, // 'VERIFIED' | 'FALSE' | 'UNCLEAR'
    reasoning: string,
    manager: EntityManager,
  ): Promise<void> {
    // Resolve recipients from canonical events
    const recipientIds = await this.getVerificationRecipients(claimId, verifierId, manager);

    if (recipientIds.length === 0) {
      this.logger.warn(
        `No recipients resolved for verification completion ${verificationId} on claim ${claimId}`,
      );
      return; // Fail closed: don't publish event with empty recipient list
    }

    const event: PublishEventDto = {
      eventType: EventType.VERIFICATION_COMPLETED,
      aggregateId: verificationId,
      recipientIds,
      metadata: {
        verificationId,
        claimId,
        claimTitle,
        verdict,
        // Note: reasoning and verifierId intentionally omitted for privacy
        // Recipients can view full details via claimUrl if authorized
        claimUrl: `https://truthbounty.io/claims/${claimId}`,
      },
      sourceUserId: verifierId,
      tags: ['verification', 'completion'],
    };

    await this.eventPublisher.publishEvent(event, manager);
    this.logger.log(
      `Published VERIFICATION_COMPLETED for verification ${verificationId} to ${recipientIds.length} recipients`,
    );
  }

  /**
   * Publish verification contested event
   * Notifies moderators, original verifier, and claim creator (excluding contestor)
   */
  async publishVerificationContested(
    verificationId: string,
    verifierId: string,
    claimId: string,
    claimTitle: string,
    contesterId: string,
    reason: string,
    manager: EntityManager,
  ): Promise<void> {
    // Resolve recipients: moderators + verifier + claim creator
    const recipientIds = await this.getContestationRecipients(
      claimId,
      verificationId,
      verifierId,
      contesterId,
      manager,
    );

    if (recipientIds.length === 0) {
      this.logger.warn(
        `No recipients resolved for contestation ${verificationId} on claim ${claimId}`,
      );
      return; // Fail closed: don't publish event with empty recipient list
    }

    const event: PublishEventDto = {
      eventType: EventType.VERIFICATION_CONTESTED,
      aggregateId: verificationId,
      recipientIds,
      metadata: {
        verificationId,
        claimId,
        claimTitle,
        // Note: reason and contesterId intentionally omitted for privacy
        // Moderators can view full details via claimUrl
        claimUrl: `https://truthbounty.io/claims/${claimId}`,
      },
      sourceUserId: contesterId,
      tags: ['verification', 'contested'],
    };

    await this.eventPublisher.publishEvent(event, manager);
    this.logger.log(
      `Published VERIFICATION_CONTESTED for verification ${verificationId} to ${recipientIds.length} recipients`,
    );
  }

  // Helper methods for recipient resolution

  /**
   * Resolve claim creator from canonical events
   * Queries EvidenceRegistered event (first evidence for this claim)
   * Returns null if no evidence exists (fail closed)
   */
  private async getClaimCreator(
    claimId: string,
    manager: EntityManager,
  ): Promise<string | null> {
    const evidenceEvent = await manager
      .getRepository(CanonicalEvent)
      .createQueryBuilder('e')
      .where('e.eventName = :eventName', { eventName: 'EvidenceRegistered' })
      .andWhere('e.claimId = :claimId', { claimId })
      .orderBy('e.blockNumber', 'ASC')
      .addOrderBy('e.logIndex', 'ASC')
      .limit(1)
      .getOne();

    if (!evidenceEvent || !evidenceEvent.actor) {
      this.logger.warn(
        `No claim creator found for claim ${claimId} (no EvidenceRegistered event)`,
      );
      return null;
    }

    return evidenceEvent.actor;
  }

  /**
   * Resolve all verifiers who submitted positions on a claim
   * Queries PositionCommitted events for this claim
   * Returns empty array if no positions exist (not an error - claim may be new)
   */
  private async getClaimVerifiers(
    claimId: string,
    manager: EntityManager,
  ): Promise<string[]> {
    const positionEvents = await manager
      .getRepository(CanonicalEvent)
      .createQueryBuilder('e')
      .where('e.eventName = :eventName', { eventName: 'PositionCommitted' })
      .andWhere('e.claimId = :claimId', { claimId })
      .andWhere('e.actor IS NOT NULL')
      .orderBy('e.blockNumber', 'ASC')
      .addOrderBy('e.logIndex', 'ASC')
      .getMany();

    // Extract unique actors (participants)
    const verifiers = new Set<string>();
    for (const event of positionEvents) {
      if (event.actor) {
        verifiers.add(event.actor);
      }
    }

    return Array.from(verifiers);
  }

  /**
   * Resolve moderators and admins from User entity
   * Queries users with MODERATOR, ADMIN, or SUPER_ADMIN roles
   * Returns wallet addresses (normalized, lowercase)
   */
  private async getModerators(manager: EntityManager): Promise<string[]> {
    const moderatorUsers = await manager
      .getRepository(User)
      .createQueryBuilder('u')
      .where('u.role IN (:...roles)', {
        roles: [UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN],
      })
      .getMany();

    return moderatorUsers
      .map((u) => u.walletAddress.toLowerCase())
      .filter((addr) => addr && addr.length > 0);
  }

  /**
   * Get recipients for verification completion event
   * Notifies: claim creator + other verifiers (excluding the submitting verifier)
   * Fails closed: returns empty array if claim creator cannot be resolved
   */
  private async getVerificationRecipients(
    claimId: string,
    verifierId: string,
    manager: EntityManager,
  ): Promise<string[]> {
    const recipients = new Set<string>();

    // 1. Get claim creator (mandatory)
    const creator = await this.getClaimCreator(claimId, manager);
    if (!creator) {
      this.logger.error(
        `Cannot resolve verification recipients: claim creator not found for claim ${claimId}`,
      );
      return []; // Fail closed
    }
    recipients.add(creator.toLowerCase());

    // 2. Get other verifiers who submitted positions
    const verifiers = await this.getClaimVerifiers(claimId, manager);
    for (const verifier of verifiers) {
      recipients.add(verifier.toLowerCase());
    }

    // 3. Exclude the submitting verifier (no self-notification)
    recipients.delete(verifierId.toLowerCase());

    const recipientList = Array.from(recipients);
    this.logger.debug(
      `Resolved ${recipientList.length} recipients for verification completion on claim ${claimId}`,
    );

    return recipientList;
  }

  /**
   * Get recipients for contestation event
   * Notifies: moderators + original verifier + claim creator (excluding contestor)
   * Fails closed: returns empty array if claim creator cannot be resolved
   */
  private async getContestationRecipients(
    claimId: string,
    verificationId: string,
    verifierId: string,
    contesterId: string,
    manager: EntityManager,
  ): Promise<string[]> {
    const recipients = new Set<string>();

    // 1. Get claim creator (mandatory)
    const creator = await this.getClaimCreator(claimId, manager);
    if (!creator) {
      this.logger.error(
        `Cannot resolve contestation recipients: claim creator not found for claim ${claimId}`,
      );
      return []; // Fail closed
    }
    recipients.add(creator.toLowerCase());

    // 2. Add the original verifier whose result is contested
    if (verifierId) {
      recipients.add(verifierId.toLowerCase());
    }

    // 3. Add all moderators (authorized to handle contestations)
    const moderators = await this.getModerators(manager);
    for (const moderator of moderators) {
      recipients.add(moderator.toLowerCase());
    }

    // 4. Exclude the contestor (no self-notification)
    recipients.delete(contesterId.toLowerCase());

    const recipientList = Array.from(recipients);
    this.logger.debug(
      `Resolved ${recipientList.length} recipients for contestation on verification ${verificationId}`,
    );

    return recipientList;
  }
}

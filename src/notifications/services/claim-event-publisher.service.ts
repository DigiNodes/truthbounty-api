import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { NotificationEventPublisher } from './notification-event-publisher.service';
import { EventType } from '../enums/event-type.enum';
import { PublishEventDto } from '../dto/publish-event.dto';

/**
 * ClaimEventPublisher
 * 
 * Publishes notification events for claim-related protocol events.
 * Called by the Claims module when significant events occur.
 * 
 * Events:
 * - CLAIM_CREATED: New claim submitted
 * - CLAIM_UPDATED: Claim details modified
 * - CLAIM_RESOLVED: Final verdict reached
 * - CLAIM_ARCHIVED: Claim archived
 */
@Injectable()
export class ClaimEventPublisher {
  private readonly logger = new Logger(ClaimEventPublisher.name);

  constructor(private eventPublisher: NotificationEventPublisher) {}

  /**
   * Publish claim created event
   * Notifies stakeholders that a new claim has been created
   */
  async publishClaimCreated(
    claimId: string,
    creatorId: string,
    title: string,
    description: string,
    amount: number,
    manager: EntityManager,
  ): Promise<void> {
    const event: PublishEventDto = {
      eventType: EventType.CLAIM_CREATED,
      aggregateId: claimId,
      recipientIds: this.getClaimCreatedRecipients(creatorId),
      metadata: {
        claimId,
        creatorId,
        title,
        description,
        amount,
        claimUrl: `https://truthbounty.io/claims/${claimId}`,
      },
      sourceUserId: creatorId,
      tags: ['claim', 'protocol-event'],
    };

    await this.eventPublisher.publishEvent(event, manager);
    this.logger.log(`Published CLAIM_CREATED for claim ${claimId}`);
  }

  /**
   * Publish claim updated event
   */
  async publishClaimUpdated(
    claimId: string,
    updaterId: string,
    title: string,
    changes: Record<string, any>,
    manager: EntityManager,
  ): Promise<void> {
    const event: PublishEventDto = {
      eventType: EventType.CLAIM_UPDATED,
      aggregateId: claimId,
      recipientIds: this.getClaimUpdatedRecipients(claimId),
      metadata: {
        claimId,
        updaterId,
        title,
        changes,
        claimUrl: `https://truthbounty.io/claims/${claimId}`,
      },
      sourceUserId: updaterId,
      tags: ['claim', 'update'],
    };

    await this.eventPublisher.publishEvent(event, manager);
  }

  /**
   * Publish claim resolved event
   */
  async publishClaimResolved(
    claimId: string,
    title: string,
    verdict: string, // 'VERIFIED' | 'FALSE' | 'UNCLEAR'
    verificationCount: number,
    manager: EntityManager,
  ): Promise<void> {
    const event: PublishEventDto = {
      eventType: EventType.CLAIM_RESOLVED,
      aggregateId: claimId,
      recipientIds: this.getClaimResolvedRecipients(claimId),
      metadata: {
        claimId,
        title,
        verdict,
        verificationCount,
        claimUrl: `https://truthbounty.io/claims/${claimId}`,
      },
      tags: ['claim', 'resolution'],
    };

    await this.eventPublisher.publishEvent(event, manager);
  }

  /**
   * Publish claim archived event
   */
  async publishClaimArchived(
    claimId: string,
    title: string,
    reason: string,
    manager: EntityManager,
  ): Promise<void> {
    const event: PublishEventDto = {
      eventType: EventType.CLAIM_ARCHIVED,
      aggregateId: claimId,
      recipientIds: this.getClaimArchivedRecipients(claimId),
      metadata: {
        claimId,
        title,
        reason,
      },
      tags: ['claim', 'archived'],
    };

    await this.eventPublisher.publishEvent(event, manager);
  }

  // Helper methods to determine recipients
  private getClaimCreatedRecipients(creatorId: string): string[] {
    // TODO: Query subscribed verifiers, governance, etc.
    return [creatorId];
  }

  private getClaimUpdatedRecipients(claimId: string): string[] {
    // TODO: Query claim stakeholders (creator, verifiers, commenters)
    return [];
  }

  private getClaimResolvedRecipients(claimId: string): string[] {
    // TODO: Query all claim stakeholders
    return [];
  }

  private getClaimArchivedRecipients(claimId: string): string[] {
    // TODO: Query claim stakeholders
    return [];
  }
}

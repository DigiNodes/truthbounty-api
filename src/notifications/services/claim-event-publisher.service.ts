import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { NotificationEventPublisher } from './notification-event-publisher.service';
import { EventType } from '../enums/event-type.enum';
import { PublishEventDto } from '../dto/publish-event.dto';
import { ClaimStakeholderResolver } from './claim-stakeholder-resolver.service';

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

  constructor(
    private eventPublisher: NotificationEventPublisher,
    private stakeholderResolver: ClaimStakeholderResolver,
  ) {}

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
    const recipientIds = await this.stakeholderResolver.getClaimCreatedRecipients(
      claimId,
      creatorId,
      manager,
    );

    const event: PublishEventDto = {
      eventType: EventType.CLAIM_CREATED,
      aggregateId: claimId,
      recipientIds,
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
    this.logger.log(`Published CLAIM_CREATED for claim ${claimId} to ${recipientIds.length} recipients`);
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
    const recipientIds = await this.stakeholderResolver.getClaimUpdatedRecipients(
      claimId,
      updaterId,
      manager,
    );

    if (recipientIds.length === 0) {
      this.logger.debug(`No recipients for CLAIM_UPDATED event ${claimId}`);
      return;
    }

    const event: PublishEventDto = {
      eventType: EventType.CLAIM_UPDATED,
      aggregateId: claimId,
      recipientIds,
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
    this.logger.log(`Published CLAIM_UPDATED for claim ${claimId} to ${recipientIds.length} recipients`);
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
    const recipientIds = await this.stakeholderResolver.getClaimResolvedRecipients(
      claimId,
      manager,
    );

    if (recipientIds.length === 0) {
      this.logger.debug(`No recipients for CLAIM_RESOLVED event ${claimId}`);
      return;
    }

    const event: PublishEventDto = {
      eventType: EventType.CLAIM_RESOLVED,
      aggregateId: claimId,
      recipientIds,
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
    this.logger.log(`Published CLAIM_RESOLVED for claim ${claimId} to ${recipientIds.length} recipients`);
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
    const recipientIds = await this.stakeholderResolver.getClaimArchivedRecipients(
      claimId,
      manager,
    );

    if (recipientIds.length === 0) {
      this.logger.debug(`No recipients for CLAIM_ARCHIVED event ${claimId}`);
      return;
    }

    const event: PublishEventDto = {
      eventType: EventType.CLAIM_ARCHIVED,
      aggregateId: claimId,
      recipientIds,
      metadata: {
        claimId,
        title,
        reason,
      },
      tags: ['claim', 'archived'],
    };

    await this.eventPublisher.publishEvent(event, manager);
    this.logger.log(`Published CLAIM_ARCHIVED for claim ${claimId} to ${recipientIds.length} recipients`);
  }
}

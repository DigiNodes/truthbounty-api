import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { NotificationEventPublisher } from './notification-event-publisher.service';
import { EventType } from '../enums/event-type.enum';
import { PublishEventDto } from '../dto/publish-event.dto';

/**
 * VerificationEventPublisher
 * 
 * Publishes notification events for verification-related protocol events.
 * 
 * Events:
 * - VERIFICATION_ASSIGNED: Verifier assigned to claim
 * - VERIFICATION_COMPLETED: Verification result submitted
 * - VERIFICATION_CONTESTED: Verification result disputed
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
    // Notify claim creator and other stakeholders
    const recipientIds = await this.getVerificationRecipients(claimId, verifierId);

    const event: PublishEventDto = {
      eventType: EventType.VERIFICATION_COMPLETED,
      aggregateId: verificationId,
      recipientIds,
      metadata: {
        verificationId,
        verifierId,
        claimId,
        claimTitle,
        verdict,
        reasoning,
        claimUrl: `https://truthbounty.io/claims/${claimId}`,
      },
      sourceUserId: verifierId,
      tags: ['verification', 'completion'],
    };

    await this.eventPublisher.publishEvent(event, manager);
  }

  /**
   * Publish verification contested event
   */
  async publishVerificationContested(
    verificationId: string,
    claimId: string,
    claimTitle: string,
    contesterId: string,
    reason: string,
    manager: EntityManager,
  ): Promise<void> {
    const event: PublishEventDto = {
      eventType: EventType.VERIFICATION_CONTESTED,
      aggregateId: verificationId,
      recipientIds: this.getContestationRecipients(claimId, contesterId),
      metadata: {
        verificationId,
        claimId,
        claimTitle,
        contesterId,
        reason,
        claimUrl: `https://truthbounty.io/claims/${claimId}`,
      },
      sourceUserId: contesterId,
      tags: ['verification', 'contested'],
    };

    await this.eventPublisher.publishEvent(event, manager);
  }

  // Helpers
  private async getVerificationRecipients(claimId: string, verifierId: string): Promise<string[]> {
    // TODO: Query claim creator and other verifiers
    return [];
  }

  private getContestationRecipients(claimId: string, contesterId: string): string[] {
    // TODO: Query governance and moderators
    return [];
  }
}

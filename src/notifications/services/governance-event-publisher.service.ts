import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { NotificationEventPublisher } from './notification-event-publisher.service';
import { EventType } from '../enums/event-type.enum';
import { PublishEventDto } from '../dto/publish-event.dto';
import { GovernanceParticipantResolver } from './governance-participant-resolver.service';

/**
 * GovernanceEventPublisher
 * 
 * Publishes notification events for governance-related protocol events.
 * 
 * Events:
 * - GOVERNANCE_PROPOSAL_CREATED: New governance proposal
 * - GOVERNANCE_VOTE_REMINDER: Voting deadline approaching
 * - GOVERNANCE_VOTE_CAST: User has voted
 * - GOVERNANCE_VOTE_CLOSED: Voting has ended
 * - GOVERNANCE_PROPOSAL_EXECUTED: Proposal executed
 */
@Injectable()
export class GovernanceEventPublisher {
  private readonly logger = new Logger(GovernanceEventPublisher.name);

  constructor(
    private eventPublisher: NotificationEventPublisher,
    private participantResolver: GovernanceParticipantResolver,
  ) {}

  /**
   * Publish governance proposal created event
   */
  async publishProposalCreated(
    proposalId: string,
    proposerId: string,
    title: string,
    description: string,
    votingDeadline: Date,
    manager: EntityManager,
  ): Promise<void> {
    // Get eligible participants (async, no manager needed for this query)
    const recipientIds = await this.participantResolver.getProposalCreatedParticipants(proposalId);

    if (recipientIds.length === 0) {
      this.logger.warn(`No governance participants found for proposal ${proposalId}`);
      return;
    }

    const event: PublishEventDto = {
      eventType: EventType.GOVERNANCE_PROPOSAL_CREATED,
      aggregateId: proposalId,
      recipientIds,
      metadata: {
        proposalId,
        proposerId,
        title,
        description,
        votingDeadline: votingDeadline.toISOString(),
        proposalUrl: `https://truthbounty.io/governance/proposals/${proposalId}`,
      },
      sourceUserId: proposerId,
      tags: ['governance', 'proposal'],
    };

    await this.eventPublisher.publishEvent(event, manager);
    this.logger.log(`Published GOVERNANCE_PROPOSAL_CREATED for ${proposalId} to ${recipientIds.length} participants`);
  }

  /**
   * Publish governance vote reminder event
   */
  async publishVoteReminder(
    proposalId: string,
    title: string,
    timeRemaining: string, // e.g., "6 hours"
    manager: EntityManager,
  ): Promise<void> {
    const recipientIds = await this.participantResolver.getVoteReminderParticipants(proposalId);

    if (recipientIds.length === 0) {
      this.logger.debug(`No eligible recipients for vote reminder ${proposalId}`);
      return;
    }

    const event: PublishEventDto = {
      eventType: EventType.GOVERNANCE_VOTE_REMINDER,
      aggregateId: proposalId,
      recipientIds,
      metadata: {
        proposalId,
        title,
        timeRemaining,
        proposalUrl: `https://truthbounty.io/governance/proposals/${proposalId}`,
      },
      tags: ['governance', 'vote-reminder'],
    };

    await this.eventPublisher.publishEvent(event, manager);
    this.logger.log(`Published GOVERNANCE_VOTE_REMINDER for ${proposalId} to ${recipientIds.length} participants`);
  }

  /**
   * Publish vote cast event
   */
  async publishVoteCast(
    proposalId: string,
    voterId: string,
    choice: string, // 'FOR' | 'AGAINST' | 'ABSTAIN'
    votingPower: number,
    manager: EntityManager,
  ): Promise<void> {
    const event: PublishEventDto = {
      eventType: EventType.GOVERNANCE_VOTE_CAST,
      aggregateId: `vote:${proposalId}:${voterId}`,
      recipientIds: [voterId],
      metadata: {
        proposalId,
        voterId,
        choice,
        votingPower,
      },
      sourceUserId: voterId,
      tags: ['governance', 'vote-cast'],
    };

    await this.eventPublisher.publishEvent(event, manager);
  }

  /**
   * Publish voting closed event
   */
  async publishVotingClosed(
    proposalId: string,
    title: string,
    result: string, // 'PASSED' | 'FAILED' | 'TIED'
    forVotes: number,
    againstVotes: number,
    manager: EntityManager,
  ): Promise<void> {
    const recipientIds = await this.participantResolver.getVoteClosedParticipants(proposalId);

    if (recipientIds.length === 0) {
      this.logger.warn(`No eligible recipients for vote closed ${proposalId}`);
      return;
    }

    const event: PublishEventDto = {
      eventType: EventType.GOVERNANCE_VOTE_CLOSED,
      aggregateId: proposalId,
      recipientIds,
      metadata: {
        proposalId,
        title,
        result,
        forVotes,
        againstVotes,
        proposalUrl: `https://truthbounty.io/governance/proposals/${proposalId}`,
      },
      tags: ['governance', 'vote-closed'],
    };

    await this.eventPublisher.publishEvent(event, manager);
    this.logger.log(`Published GOVERNANCE_VOTE_CLOSED for ${proposalId} to ${recipientIds.length} participants`);
  }

  /**
   * Publish proposal executed event
   */
  async publishProposalExecuted(
    proposalId: string,
    title: string,
    action: string,
    manager: EntityManager,
  ): Promise<void> {
    const recipientIds = await this.participantResolver.getProposalExecutedParticipants(proposalId);

    if (recipientIds.length === 0) {
      this.logger.warn(`No eligible recipients for proposal executed ${proposalId}`);
      return;
    }

    const event: PublishEventDto = {
      eventType: EventType.GOVERNANCE_PROPOSAL_EXECUTED,
      aggregateId: proposalId,
      recipientIds,
      metadata: {
        proposalId,
        title,
        action,
        proposalUrl: `https://truthbounty.io/governance/proposals/${proposalId}`,
      },
      tags: ['governance', 'executed'],
    };

    await this.eventPublisher.publishEvent(event, manager);
    this.logger.log(`Published GOVERNANCE_PROPOSAL_EXECUTED for ${proposalId} to ${recipientIds.length} participants`);
  }
}

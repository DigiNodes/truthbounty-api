import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { NotificationEventPublisher } from './notification-event-publisher.service';
import { EventType } from '../enums/event-type.enum';
import { PublishEventDto } from '../dto/publish-event.dto';

/**
 * RewardEventPublisher
 * 
 * Publishes notification events for reward-related protocol events.
 * 
 * Events:
 * - REWARD_ELIGIBLE: User becomes eligible for rewards
 * - REWARD_DISTRIBUTED: Rewards have been distributed
 * - REWARD_CLAIMED: User has claimed their rewards
 */
@Injectable()
export class RewardEventPublisher {
  private readonly logger = new Logger(RewardEventPublisher.name);

  constructor(private eventPublisher: NotificationEventPublisher) {}

  /**
   * Publish reward eligible event
   */
  async publishRewardEligible(
    userId: string,
    rewardAmount: number,
    rewardType: string,
    claimId: string,
    manager: EntityManager,
  ): Promise<void> {
    const event: PublishEventDto = {
      eventType: EventType.REWARD_ELIGIBLE,
      aggregateId: `reward:${userId}:${claimId}`,
      recipientIds: [userId],
      metadata: {
        userId,
        amount: rewardAmount,
        type: rewardType,
        claimId,
        claimUrl: `https://truthbounty.io/claims/${claimId}`,
        rewardsUrl: `https://truthbounty.io/rewards`,
      },
      tags: ['reward', 'eligible'],
    };

    await this.eventPublisher.publishEvent(event, manager);
    this.logger.log(`Published REWARD_ELIGIBLE for user ${userId}`);
  }

  /**
   * Publish reward distributed event
   */
  async publishRewardDistributed(
    userId: string,
    rewardAmount: number,
    rewardType: string,
    reason: string,
    manager: EntityManager,
  ): Promise<void> {
    const event: PublishEventDto = {
      eventType: EventType.REWARD_DISTRIBUTED,
      aggregateId: `reward:${userId}:${Date.now()}`,
      recipientIds: [userId],
      metadata: {
        userId,
        amount: rewardAmount,
        type: rewardType,
        reason,
        rewardsUrl: `https://truthbounty.io/rewards/history`,
      },
      tags: ['reward', 'distribution'],
    };

    await this.eventPublisher.publishEvent(event, manager);
  }

  /**
   * Publish reward claimed event
   */
  async publishRewardClaimed(
    userId: string,
    claimedAmount: number,
    manager: EntityManager,
  ): Promise<void> {
    const event: PublishEventDto = {
      eventType: EventType.REWARD_CLAIMED,
      aggregateId: `claim:${userId}:${Date.now()}`,
      recipientIds: [userId],
      metadata: {
        userId,
        amount: claimedAmount,
        walletUrl: `https://truthbounty.io/wallet`,
      },
      tags: ['reward', 'claimed'],
    };

    await this.eventPublisher.publishEvent(event, manager);
  }
}

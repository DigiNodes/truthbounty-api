import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationEventPublisher } from './notification-event-publisher.service';
import { EventType } from '../enums/event-type.enum';
import { PublishEventDto } from '../dto/publish-event.dto';
import { CanonicalEvent } from '../../v2/events/entities/canonical-event.entity';
import { ProjectVerificationRound } from '../../v2/verification/entities/project-verification-round.entity';
import { ProjectParticipantPosition } from '../../v2/verification/entities/project-participant-position.entity';
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
 * Recipient Resolution:
 * - Verification completion: claim creator, assigned verifiers (excluding submitter), authorized moderators
 * - Contestation: original verifier, claim creator, authorized moderators (excluding contester)
 * 
 * Security:
 * - Fails closed on missing, stale, or ambiguous state
 * - Deduplicates recipients and excludes self-notification
 * - Only includes authorized moderators (MODERATOR, ADMIN, SUPER_ADMIN)
 */
@Injectable()
export class VerificationEventPublisher {
  private readonly logger = new Logger(VerificationEventPublisher.name);

  constructor(
    private eventPublisher: NotificationEventPublisher,
    @InjectRepository(CanonicalEvent)
    private canonicalEventRepo: Repository<CanonicalEvent>,
    @InjectRepository(ProjectVerificationRound)
    private verificationRoundRepo: Repository<ProjectVerificationRound>,
    @InjectRepository(ProjectParticipantPosition)
    private participantPositionRepo: Repository<ProjectParticipantPosition>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
  ) {}

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
   * 
   * Notifies:
   * - Claim creator
   * - Other assigned verifiers (excluding the submitting verifier)
   * - Authorized moderators
   * 
   * @param verificationId The verification/round ID
   * @param verifierId The verifier who submitted the verification (blockchain address)
   * @param claimId The claim ID
   * @param claimTitle The claim title (privacy-safe)
   * @param verdict The verification verdict
   * @param reasoning The verification reasoning (privacy-safe)
   * @param manager EntityManager for transactional write
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
    // Resolve recipients with event-specific logic
    const recipientIds = await this.getVerificationRecipients(claimId, verifierId, manager);

    // Fail closed: do not publish if recipient resolution failed
    if (recipientIds.length === 0) {
      this.logger.warn(
        `No recipients resolved for verification completion ${verificationId}, skipping notification`,
      );
      return;
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
    this.logger.log(`Published VERIFICATION_COMPLETED for verification ${verificationId}`);
  }

  /**
   * Publish verification contested event
   * 
   * Notifies:
   * - Original verifier(s) whose verification is being contested
   * - Claim creator
   * - Authorized moderators
   * 
   * @param verificationId The verification/round ID being contested
   * @param claimId The claim ID
   * @param claimTitle The claim title (privacy-safe)
   * @param contesterId The user contesting the verification (blockchain address)
   * @param reason The contestation reason (privacy-safe)
   * @param manager EntityManager for transactional write
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
    // Resolve recipients with event-specific logic
    const recipientIds = await this.getContestationRecipients(
      verificationId,
      claimId,
      contesterId,
      manager,
    );

    // Fail closed: do not publish if recipient resolution failed
    if (recipientIds.length === 0) {
      this.logger.warn(
        `No recipients resolved for verification contestation ${verificationId}, skipping notification`,
      );
      return;
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
    this.logger.log(`Published VERIFICATION_CONTESTED for verification ${verificationId}`);
  }

  /**
   * Resolve recipients for verification completion notification.
   * 
   * Recipients include:
   * - Claim creator (from EvidenceRegistered event actor)
   * - Other assigned verifiers (excluding the submitting verifier)
   * - Authorized moderators (MODERATOR, ADMIN, SUPER_ADMIN roles)
   * 
   * Security guarantees:
   * - Deduplicates recipient IDs
   * - Excludes self-notification (verifierId)
   * - Fails closed on missing claim data
   * - Only includes authorized moderation roles
   * 
   * @param claimId The claim ID for which verification was completed
   * @param verifierId The verifier who submitted the verification (excluded from recipients)
   * @param manager Optional EntityManager for transactional query
   * @returns Array of unique user IDs to notify
   */
  private async getVerificationRecipients(
    claimId: string,
    verifierId: string,
    manager?: EntityManager,
  ): Promise<string[]> {
    const recipientSet = new Set<string>();

    try {
      // 1. Find claim creator from EvidenceRegistered canonical event
      const canonicalRepo = manager
        ? manager.getRepository(CanonicalEvent)
        : this.canonicalEventRepo;

      const evidenceEvent = await canonicalRepo.findOne({
        where: {
          eventName: 'EvidenceRegistered',
          claimId,
        },
        order: { blockNumber: 'ASC', logIndex: 'ASC' },
      });

      if (evidenceEvent?.actor) {
        // Convert blockchain address to user ID
        const claimCreator = await this.findUserByAddress(evidenceEvent.actor, manager);
        if (claimCreator) {
          recipientSet.add(claimCreator.id);
          this.logger.debug(`Added claim creator ${claimCreator.id} to recipients`);
        } else {
          this.logger.warn(
            `Claim creator address ${evidenceEvent.actor} not found in users table for claim ${claimId}`,
          );
        }
      } else {
        this.logger.warn(
          `No EvidenceRegistered event found for claim ${claimId}, cannot determine claim creator`,
        );
      }

      // 2. Find other assigned verifiers (excluding the submitting verifier)
      const roundRepo = manager
        ? manager.getRepository(ProjectVerificationRound)
        : this.verificationRoundRepo;

      const positionRepo = manager
        ? manager.getRepository(ProjectParticipantPosition)
        : this.participantPositionRepo;

      // Get all rounds for this claim
      const rounds = await roundRepo.find({
        where: { claimId },
      });

      for (const round of rounds) {
        // Get all participants in this round
        const positions = await positionRepo.find({
          where: { roundId: round.roundId },
        });

        for (const position of positions) {
          // Convert participant address to user ID
          const participant = await this.findUserByAddress(position.participant, manager);
          if (participant) {
            recipientSet.add(participant.id);
            this.logger.debug(`Added verifier ${participant.id} to recipients`);
          }
        }
      }

      // 3. Include authorized moderators
      const moderators = await this.getAuthorizedModerators(manager);
      moderators.forEach((mod) => {
        recipientSet.add(mod.id);
        this.logger.debug(`Added moderator ${mod.id} to recipients`);
      });

      // 4. Remove self-notification (the verifier who submitted)
      const verifierUser = await this.findUserByAddress(verifierId, manager);
      if (verifierUser) {
        recipientSet.delete(verifierUser.id);
        this.logger.debug(`Excluded submitting verifier ${verifierUser.id} from recipients`);
      }

      const recipients = Array.from(recipientSet);
      this.logger.log(
        `Resolved ${recipients.length} recipients for verification completion on claim ${claimId}`,
      );

      return recipients;
    } catch (error) {
      this.logger.error(
        `Failed to resolve verification recipients for claim ${claimId}: ${error.message}`,
        error.stack,
      );
      // Fail closed: return empty array rather than risk exposing notifications to wrong users
      return [];
    }
  }

  /**
   * Resolve recipients for verification contestation notification.
   * 
   * Recipients include:
   * - Original verifier whose verification is being contested
   * - Claim creator (from EvidenceRegistered event actor)
   * - Authorized moderators (MODERATOR, ADMIN, SUPER_ADMIN roles)
   * 
   * Security guarantees:
   * - Deduplicates recipient IDs
   * - Excludes self-notification (contesterId)
   * - Fails closed on missing verification/claim data
   * - Only includes authorized moderation roles
   * 
   * @param verificationId The verification ID being contested
   * @param claimId The claim ID associated with the verification
   * @param contesterId The user contesting the verification (excluded from recipients)
   * @param manager Optional EntityManager for transactional query
   * @returns Array of unique user IDs to notify
   */
  private async getContestationRecipients(
    verificationId: string,
    claimId: string,
    contesterId: string,
    manager?: EntityManager,
  ): Promise<string[]> {
    const recipientSet = new Set<string>();

    try {
      // 1. Find the original verifier from participant positions
      // The verificationId in this context is the roundId
      const positionRepo = manager
        ? manager.getRepository(ProjectParticipantPosition)
        : this.participantPositionRepo;

      const positions = await positionRepo.find({
        where: { roundId: verificationId },
      });

      for (const position of positions) {
        const verifier = await this.findUserByAddress(position.participant, manager);
        if (verifier) {
          recipientSet.add(verifier.id);
          this.logger.debug(`Added original verifier ${verifier.id} to contestation recipients`);
        }
      }

      // 2. Find claim creator from EvidenceRegistered canonical event
      const canonicalRepo = manager
        ? manager.getRepository(CanonicalEvent)
        : this.canonicalEventRepo;

      const evidenceEvent = await canonicalRepo.findOne({
        where: {
          eventName: 'EvidenceRegistered',
          claimId,
        },
        order: { blockNumber: 'ASC', logIndex: 'ASC' },
      });

      if (evidenceEvent?.actor) {
        const claimCreator = await this.findUserByAddress(evidenceEvent.actor, manager);
        if (claimCreator) {
          recipientSet.add(claimCreator.id);
          this.logger.debug(`Added claim creator ${claimCreator.id} to contestation recipients`);
        } else {
          this.logger.warn(
            `Claim creator address ${evidenceEvent.actor} not found in users table for claim ${claimId}`,
          );
        }
      } else {
        this.logger.warn(
          `No EvidenceRegistered event found for claim ${claimId}, cannot determine claim creator`,
        );
      }

      // 3. Include authorized moderators
      const moderators = await this.getAuthorizedModerators(manager);
      moderators.forEach((mod) => {
        recipientSet.add(mod.id);
        this.logger.debug(`Added moderator ${mod.id} to contestation recipients`);
      });

      // 4. Remove self-notification (the contester)
      const contesterUser = await this.findUserByAddress(contesterId, manager);
      if (contesterUser) {
        recipientSet.delete(contesterUser.id);
        this.logger.debug(`Excluded contester ${contesterUser.id} from recipients`);
      }

      const recipients = Array.from(recipientSet);
      this.logger.log(
        `Resolved ${recipients.length} recipients for contestation on verification ${verificationId}`,
      );

      return recipients;
    } catch (error) {
      this.logger.error(
        `Failed to resolve contestation recipients for verification ${verificationId}: ${error.message}`,
        error.stack,
      );
      // Fail closed: return empty array rather than risk exposing notifications to wrong users
      return [];
    }
  }

  /**
   * Find user by wallet address.
   * Addresses are normalized to lowercase for comparison.
   * 
   * @param address Blockchain address (0x-prefixed hex)
   * @param manager Optional EntityManager for transactional query
   * @returns User entity or null if not found
   */
  private async findUserByAddress(
    address: string,
    manager?: EntityManager,
  ): Promise<User | null> {
    if (!address) {
      return null;
    }

    const userRepo = manager ? manager.getRepository(User) : this.userRepo;
    
    const normalizedAddress = address.toLowerCase();
    return userRepo.findOne({
      where: { walletAddress: normalizedAddress },
    });
  }

  /**
   * Get all users with authorized moderation roles.
   * Only includes MODERATOR, ADMIN, and SUPER_ADMIN roles.
   * 
   * @param manager Optional EntityManager for transactional query
   * @returns Array of users with moderation privileges
   */
  private async getAuthorizedModerators(manager?: EntityManager): Promise<User[]> {
    const userRepo = manager ? manager.getRepository(User) : this.userRepo;

    const authorizedRoles = [UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN];

    return userRepo
      .createQueryBuilder('user')
      .where('user.role IN (:...roles)', { roles: authorizedRoles })
      .getMany();
  }
}

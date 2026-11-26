import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Vote } from '../../governance/entities/proposal.entity';

/**
 * Governance eligibility configuration
 * 
 * Controls who receives governance notifications based on:
 * - Recent voting activity window
 * - Maximum participants (bounded fan-out)
 * - Requirement for active voting history
 */
export interface GovernanceEligibilityConfig {
  /** Activity window in days (default: 30) */
  activityWindowDays: number;
  /** Maximum participants to notify (default: 1000) */
  maxParticipants: number;
  /** Require active voting history (default: true) */
  requireActiveVoting: boolean;
}

/**
 * GovernanceParticipantResolver
 * 
 * Resolves eligible participants for governance notification events.
 * Uses policy-backed criteria to determine who should be notified.
 * 
 * Policy:
 * - Active voters: Users who voted in last N days
 * - Proposal-specific voters: Users who voted on a specific proposal
 * - Bounded fan-out: Max 1000 participants per event
 * - No broadcast to all users: Must meet activity criteria
 * 
 * Security:
 * - Never exposes cross-user voting data
 * - Respects notification preferences
 * - Implements bounded fan-out to prevent notification spam
 */
@Injectable()
export class GovernanceParticipantResolver {
  private readonly logger = new Logger(GovernanceParticipantResolver.name);

  private readonly DEFAULT_CONFIG: GovernanceEligibilityConfig = {
    activityWindowDays: 30,
    maxParticipants: 1000,
    requireActiveVoting: true,
  };

  constructor(
    @InjectRepository(Vote)
    private voteRepository: Repository<Vote>,
  ) {}

  /**
   * Get participants for proposal-created event.
   * Policy: Active voters + users with governance role.
   * 
   * @param proposalId - The proposal ID (not used for created event)
   * @param config - Optional eligibility configuration overrides
   * @returns Array of user IDs eligible for notification
   */
  async getProposalCreatedParticipants(
    proposalId: string,
    config?: Partial<GovernanceEligibilityConfig>,
  ): Promise<string[]> {
    const eligibilityConfig = { ...this.DEFAULT_CONFIG, ...config };

    try {
      // Get users who voted in last N days
      const activityCutoff = new Date();
      activityCutoff.setDate(activityCutoff.getDate() - eligibilityConfig.activityWindowDays);

      const recentVoters = await this.voteRepository
        .createQueryBuilder('vote')
        .select('DISTINCT vote.voter')
        .where('vote.createdAt >= :cutoff', { cutoff: activityCutoff })
        .getRawMany();

      const voterIds = recentVoters.map(v => v.vote_voter);

      // TODO: Add users with governance role if role system exists
      // const governanceUsers = await this.userRepository.find({
      //   where: { role: 'governance' },
      //   select: ['id'],
      // });

      // Deduplicate and apply bounded fan-out
      const uniqueParticipants = Array.from(new Set(voterIds));

      if (uniqueParticipants.length > eligibilityConfig.maxParticipants) {
        this.logger.warn(
          `Governance participants (${uniqueParticipants.length}) exceed max (${eligibilityConfig.maxParticipants}), truncating`
        );
        return uniqueParticipants.slice(0, eligibilityConfig.maxParticipants);
      }

      return uniqueParticipants;
    } catch (error) {
      this.logger.error(
        `Failed to resolve proposal-created participants: ${error.message}`,
        error.stack
      );
      // Fail-closed: return empty array on error
      return [];
    }
  }

  /**
   * Get participants for vote-reminder event.
   * Policy: Active voters who haven't voted on this proposal yet.
   * 
   * @param proposalId - The proposal ID
   * @param config - Optional eligibility configuration overrides
   * @returns Array of user IDs eligible for notification
   */
  async getVoteReminderParticipants(
    proposalId: string,
    config?: Partial<GovernanceEligibilityConfig>,
  ): Promise<string[]> {
    const eligibilityConfig = { ...this.DEFAULT_CONFIG, ...config };

    try {
      // Get active voters
      const activeVoters = await this.getActiveVoters(eligibilityConfig.activityWindowDays);

      // Get users who already voted on this proposal
      const existingVotes = await this.voteRepository.find({
        where: { proposalId },
        select: ['voter'],
      });
      const alreadyVoted = new Set(existingVotes.map(v => v.voter));

      // Filter out users who already voted
      const eligibleParticipants = activeVoters.filter(
        voterId => !alreadyVoted.has(voterId)
      );

      // Apply bounded fan-out
      if (eligibleParticipants.length > eligibilityConfig.maxParticipants) {
        this.logger.warn(
          `Vote reminder participants (${eligibleParticipants.length}) exceed max (${eligibilityConfig.maxParticipants}), truncating`
        );
        return eligibleParticipants.slice(0, eligibilityConfig.maxParticipants);
      }

      return eligibleParticipants;
    } catch (error) {
      this.logger.error(
        `Failed to resolve vote-reminder participants for proposal ${proposalId}: ${error.message}`,
        error.stack
      );
      // Fail-closed: return empty array on error
      return [];
    }
  }

  /**
   * Get participants for vote-closed event.
   * Policy: All voters on this proposal + active governance participants.
   * 
   * @param proposalId - The proposal ID
   * @param config - Optional eligibility configuration overrides
   * @returns Array of user IDs eligible for notification
   */
  async getVoteClosedParticipants(
    proposalId: string,
    config?: Partial<GovernanceEligibilityConfig>,
  ): Promise<string[]> {
    const eligibilityConfig = { ...this.DEFAULT_CONFIG, ...config };

    try {
      // Get users who voted on this proposal
      const proposalVotes = await this.voteRepository.find({
        where: { proposalId },
        select: ['voter'],
      });
      const proposalVoterIds = proposalVotes.map(v => v.voter);

      // Get active governance participants
      const activeVoters = await this.getActiveVoters(eligibilityConfig.activityWindowDays);

      // Combine and deduplicate
      const allParticipants = Array.from(new Set([
        ...proposalVoterIds,
        ...activeVoters,
      ]));

      // Apply bounded fan-out
      if (allParticipants.length > eligibilityConfig.maxParticipants) {
        this.logger.warn(
          `Vote closed participants (${allParticipants.length}) exceed max (${eligibilityConfig.maxParticipants}), truncating`
        );
        return allParticipants.slice(0, eligibilityConfig.maxParticipants);
      }

      return allParticipants;
    } catch (error) {
      this.logger.error(
        `Failed to resolve vote-closed participants for proposal ${proposalId}: ${error.message}`,
        error.stack
      );
      // Fail-closed: return empty array on error
      return [];
    }
  }

  /**
   * Get participants for proposal-executed event.
   * Policy: Same as vote-closed.
   * 
   * @param proposalId - The proposal ID
   * @param config - Optional eligibility configuration overrides
   * @returns Array of user IDs eligible for notification
   */
  async getProposalExecutedParticipants(
    proposalId: string,
    config?: Partial<GovernanceEligibilityConfig>,
  ): Promise<string[]> {
    return this.getVoteClosedParticipants(proposalId, config);
  }

  /**
   * Helper: Get users who voted in last N days.
   * 
   * @param windowDays - Activity window in days
   * @returns Array of voter user IDs
   */
  private async getActiveVoters(windowDays: number): Promise<string[]> {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - windowDays);

      const recentVotes = await this.voteRepository
        .createQueryBuilder('vote')
        .select('DISTINCT vote.voter')
        .where('vote.createdAt >= :cutoff', { cutoff })
        .getRawMany();

      return recentVotes.map(v => v.vote_voter);
    } catch (error) {
      this.logger.error(
        `Failed to get active voters: ${error.message}`,
        error.stack
      );
      // Fail-closed: return empty array on error
      return [];
    }
  }
}

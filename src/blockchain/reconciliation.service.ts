import { Injectable, Logger } from '@nestjs/common';
import { BlockchainStateService } from './state.service';
import { ReorgDetectorService } from './reorg-detector.service';
import { ReorgEvent } from './types';
import {
  LeaderElectionService,
  LeaseContext,
  LeaseLostError,
} from './leader-election.service';

/**
 * Handles reconciliation and rollback of state after reorg detection
 *
 * Singleton jobs are guarded by a DB/Redis lease with fencing tokens. Only the
 * current leader may mutate state, and every mutation is fenced by the lease
 * token so stale leaders cannot commit work after takeover.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private readonly JOB_NAME = 'blockchain.reconciliation';

  constructor(
    private stateService: BlockchainStateService,
    private reorgDetector: ReorgDetectorService,
    private leaderElection: LeaderElectionService,
  ) {}

  /**
   * Handle a detected reorg by rolling back affected state.
   *
   * The entire rollback is executed under a lease and every mutation is fenced
   * by the lease token. If the lease is lost mid-way, the job aborts safely.
   */
  async handleReorg(reorg: ReorgEvent): Promise<void> {
    this.logger.log(
      `Handling reorg: ${reorg.orphanedEvents.length} events to rollback`,
    );

    const lease: LeaseContext | null =
      await this.leaderElection.acquireLease(this.JOB_NAME);
    if (!lease) {
      this.logger.warn(
        `Skipping reorg handling: another worker holds the ${this.JOB_NAME} lease`,
      );
      return;
    }

    try {
      await this.rollbackAffectedEvents(lease, reorg.orphanedEvents);
      await this.markBlocksAsNonCanonical(
        lease,
        reorg.affectedBlockStart,
        reorg.affectedBlockEnd,
      );
      await this.leaderElection.fenced(lease, () =>
        this.stateService.recordReorg(reorg),
      );
      await this.leaderElection.recordTakeoverAudit(lease, 'reorg-handled');

      this.logger.log(
        `Reorg handled successfully. Rolled back ${reorg.orphanedEvents.length} events`,
      );
    } catch (error) {
      if (error instanceof LeaseLostError) {
        this.logger.warn(
          `Lease lost while handling reorg; aborting work to avoid stale mutations: ${error.message}`,
        );
        return;
      }
      this.logger.error(`Failed to handle reorg: ${error}`, error);
      throw error;
    } finally {
      await this.leaderElection.releaseLease(lease);
    }
  }

  /**
   * Mark events as orphaned and prepare for reprocessing. Each mutation is
   * fenced by the lease token.
   */
  private async rollbackAffectedEvents(
    lease: LeaseContext,
    eventIds: string[],
  ): Promise<void> {
    for (const eventId of eventIds) {
      const event = await this.stateService.getEvent(eventId);
      if (event) {
        await this.leaderElection.fenced(lease, () =>
          this.stateService.updateEventStatus(eventId, 'orphaned'),
        );
        this.logger.debug(`Marked event as orphaned: ${eventId}`);
      }
    }
  }

  /**
   * Mark blocks as non-canonical.
   */
  private async markBlocksAsNonCanonical(
    lease: LeaseContext,
    startBlock: number,
    endBlock: number,
  ): Promise<void> {
    const blockNumbers: number[] = [];
    for (let i = startBlock; i <= endBlock; i++) {
      blockNumbers.push(i);
    }
    await this.leaderElection.fenced(lease, () =>
      this.stateService.markBlocksNonCanonical(blockNumbers),
    );
  }

  /**
   * Verify state consistency after reorg.
   */
  async verifyStateConsistency(): Promise<{
    isConsistent: boolean;
    issues: string[];
  }> {
    const issues: string[] = [];
    const state = await this.stateService.getChainState();
    const orphanedEvents = await this.stateService.getOrphanedEvents();

    // Check: orphaned events waiting for reprocessing are acceptable.
    for (const event of orphanedEvents) {
      if (event.status === 'orphaned' && !event.confirmedAt) {
        continue;
      }
    }

    // Check: Pending event count matches actual pending events
    const pendingEvents = await this.stateService.getPendingEvents();
    if (pendingEvents.length !== state.pendingEventCount) {
      issues.push(
        `Pending event count mismatch: stored=${state.pendingEventCount}, ` +
          `actual=${pendingEvents.length}`,
      );
    }

    // Check: Orphaned event count matches actual orphaned events
    if (orphanedEvents.length !== state.orphanedEventCount) {
      issues.push(
        `Orphaned event count mismatch: stored=${state.orphanedEventCount}, ` +
          `actual=${orphanedEvents.length}`,
      );
    }

    return {
      isConsistent: issues.length === 0,
      issues,
    };
  }

  /**
   * Reconcile orphaned events when they become canonical again.
   */
  async reconcileOrphanedEvents(headBlockNumber: number): Promise<string[]> {
    const lease: LeaseContext | null =
      await this.leaderElection.acquireLease(this.JOB_NAME);
    if (!lease) {
      this.logger.warn(
        `Skipping orphaned reconciliation: another worker holds the ${this.JOB_NAME} lease`,
      );
      return [];
    }

    const reconciled: string[] = [];
    try {
      const orphanedEvents = await this.stateService.getOrphanedEvents();

      for (const event of orphanedEvents) {
        const confirmations = await this.reorgDetector.calculateConfirmations(
          event.blockNumber,
          headBlockNumber,
        );

        const isConfirmed = await this.reorgDetector.isEventConfirmed(
          event.blockNumber,
          headBlockNumber,
        );

        if (isConfirmed) {
          await this.leaderElection.fenced(lease, () =>
            this.stateService.updateEventStatus(
              event.id,
              'confirmed',
              confirmations,
            ),
          );
          reconciled.push(event.id);
          this.logger.debug(`Reconciled orphaned event: ${event.id}`);
        }
      }

      await this.leaderElection.recordTakeoverAudit(lease, 'orphaned-reconciled');
      return reconciled;
    } catch (error) {
      if (error instanceof LeaseLostError) {
        this.logger.warn(
          `Lease lost while reconciling orphaned events; aborting work: ${error.message}`,
        );
        return reconciled;
      }
      throw error;
    } finally {
      await this.leaderElection.releaseLease(lease);
    }
  }

  /**
   * Get reorg statistics.
   */
  async getReorgStatistics(): Promise<{
    totalReorgs: number;
    lastReorgTime?: Date;
    averageReorgDepth: number;
    orphanedEventCount: number;
    pendingEventCount: number;
  }> {
    const reorgHistory = await this.stateService.getReorgHistory();
    const state = await this.stateService.getChainState();

    const totalReorgs = reorgHistory.length;
    const averageReorgDepth =
      totalReorgs > 0
        ? reorgHistory.reduce((sum, r) => sum + r.reorgDepth, 0) / totalReorgs
        : 0;

    return {
      totalReorgs,
      lastReorgTime: state.lastReorgTime,
      averageReorgDepth: Math.round(averageReorgDepth * 100) / 100,
      orphanedEventCount: state.orphanedEventCount,
      pendingEventCount: state.pendingEventCount,
    };
  }
}

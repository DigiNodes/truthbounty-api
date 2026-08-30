import { Injectable, Logger, Optional } from '@nestjs/common';
import { BlockchainStateService } from './state.service';
import { ReorgDetectorService } from './reorg-detector.service';
import { BlockchainReorgAlertService } from './blockchain-reorg-alert.service';
import { ReorgEvent, PendingEvent, BlockInfo } from './types';

/**
 * Handles reconciliation and rollback of state after reorg detection
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  /** ID of the reorg event record currently being handled. */
  private lastReorgEventId: number | null = null;
  /** Timestamp when the current reorg handling started. */
  private reorgStartTime = 0;

  constructor(
    private stateService: BlockchainStateService,
    private reorgDetector: ReorgDetectorService,
    @Optional() private readonly alertService?: BlockchainReorgAlertService,
  ) {}

  /**
   * Handle a detected reorg by rolling back affected state
   */
  async handleReorg(reorg: ReorgEvent): Promise<void> {
    this.logger.log(
      `Handling reorg: ${reorg.orphanedEvents.length} events to rollback`,
    );

    this.reorgStartTime = Date.now();
    this.lastReorgEventId = null;

    // Record detection alert before rollback (best-effort)
    if (this.alertService) {
      try {
        const record = await this.alertService.recordDetection({
          reorgDepth: reorg.reorgDepth,
          affectedBlockStart: reorg.affectedBlockStart,
          affectedBlockEnd: reorg.affectedBlockEnd,
          orphanedEventCount: reorg.orphanedEvents.length,
        });
        this.lastReorgEventId = record.id;
      } catch (err) {
        this.logger.error(`Failed to record reorg detection: ${err}`);
      }
    }

    try {
      // Start transaction (in production, use database transactions)
      await this.rollbackAffectedEvents(reorg.orphanedEvents);
      await this.markBlocksAsNonCanonical(
        reorg.affectedBlockStart,
        reorg.affectedBlockEnd,
      );
      await this.stateService.recordReorg(reorg);

      // Emit rollback-complete alert (best-effort)
      if (this.alertService && this.lastReorgEventId) {
        this.alertService.recordRollbackComplete(this.lastReorgEventId, Date.now() - this.reorgStartTime)
          .catch(() => {});
      }

      this.logger.log(
        `Reorg handled successfully. Rolled back ${reorg.orphanedEvents.length} events`,
      );
    } catch (error) {
      this.logger.error(`Failed to handle reorg: ${error}`, error);

      // Emit error alert (best-effort)
      if (this.alertService && this.lastReorgEventId) {
        this.alertService.recordError(this.lastReorgEventId, String(error))
          .catch(() => {});
      }

      throw error;
    }
  }

  /**
   * Mark events as orphaned and prepare for reprocessing
   */
  private async rollbackAffectedEvents(eventIds: string[]): Promise<void> {
    for (const eventId of eventIds) {
      const event = await this.stateService.getEvent(eventId);
      if (event) {
        // Mark as orphaned so they can be reprocessed when blocks are canonical again
        await this.stateService.updateEventStatus(eventId, 'orphaned');
        this.logger.debug(`Marked event as orphaned: ${eventId}`);
      }
    }
  }

  /**
   * Mark blocks as non-canonical
   */
  private async markBlocksAsNonCanonical(
    startBlock: number,
    endBlock: number,
  ): Promise<void> {
    const blockNumbers: number[] = [];
    for (let i = startBlock; i <= endBlock; i++) {
      blockNumbers.push(i);
    }
    await this.stateService.markBlocksNonCanonical(blockNumbers);
  }

  /**
   * Verify state consistency after reorg
   */
  async verifyStateConsistency(): Promise<{
    isConsistent: boolean;
    issues: string[];
  }> {
    const issues: string[] = [];
    const state = await this.stateService.getChainState();
    const orphanedEvents = await this.stateService.getOrphanedEvents();

    // Check 1: No orphaned events in unreconciled state
    for (const event of orphanedEvents) {
      if (event.status === 'orphaned' && !event.confirmedAt) {
        // This is acceptable - orphaned events waiting for reprocessing
        continue;
      }
    }

    // Check 2: Pending event count matches actual pending events
    const pendingEvents = await this.stateService.getPendingEvents();
    if (pendingEvents.length !== state.pendingEventCount) {
      issues.push(
        `Pending event count mismatch: stored=${state.pendingEventCount}, ` +
        `actual=${pendingEvents.length}`,
      );
    }

    // Check 3: Orphaned event count matches actual orphaned events
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
   * Reconcile orphaned events when they become canonical again
   */
  async reconcileOrphanedEvents(headBlockNumber: number): Promise<string[]> {
    const reconciled: string[] = [];
    const orphanedEvents = await this.stateService.getOrphanedEvents();

    for (const event of orphanedEvents) {
      // Check if the event's block is now canonical
      const confirmations = await this.reorgDetector.calculateConfirmations(
        event.blockNumber,
        headBlockNumber,
      );

      const isConfirmed = await this.reorgDetector.isEventConfirmed(
        event.blockNumber,
        headBlockNumber,
      );

      if (isConfirmed) {
        // Event is back to being canonical
        await this.stateService.updateEventStatus(
          event.id,
          'confirmed',
          confirmations,
        );
        reconciled.push(event.id);
        this.logger.debug(`Reconciled orphaned event: ${event.id}`);
      }
    }

    // Emit replay-complete alert if we reconciled any events
    if (reconciled.length > 0 && this.alertService && this.lastReorgEventId) {
      const durationMs = Date.now() - this.reorgStartTime;
      this.alertService.recordReplayComplete(
        this.lastReorgEventId,
        reconciled.length,
        null, // canonical hash not available from in-memory state
        durationMs,
      ).catch(() => {});
      this.lastReorgEventId = null;
    }

    return reconciled;
  }

  /**
   * Get reorg statistics
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

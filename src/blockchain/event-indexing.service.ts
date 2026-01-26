import { Injectable, Logger } from '@nestjs/common';
import { BlockchainStateService } from './state.service';
import { ReorgDetectorService } from './reorg-detector.service';
import { ReconciliationService } from './reconciliation.service';
import { BlockInfo, PendingEvent } from './types';

/**
 * Event indexing service with confirmation strategy
 * Processes blockchain events with reorg protection
 */
@Injectable()
export class EventIndexingService {
  private readonly logger = new Logger(EventIndexingService.name);
  private headBlockNumber: number = 0;

  constructor(
    private stateService: BlockchainStateService,
    private reorgDetector: ReorgDetectorService,
    private reconciliation: ReconciliationService,
  ) {}

  /**
   * Process a new block and its events
   */
  async processBlock(block: BlockInfo, events: any[]): Promise<void> {
    this.logger.log(`Processing block ${block.number} with ${events.length} events`);

    const chainState = await this.stateService.getChainState();
    const previousBlockNumber = chainState.lastProcessedBlock;

    try {
      // Step 1: Check for reorg
      const detectedReorg = await this.reorgDetector.detectReorg(
        block,
        previousBlockNumber,
      );

      if (detectedReorg) {
        // Handle the reorg
        await this.reconciliation.handleReorg(detectedReorg);
      }

      // Step 2: Save the block
      await this.stateService.saveBlock(block);
      this.headBlockNumber = block.number;

      // Step 3: Index events as pending
      for (const event of events) {
        await this.indexEvent(block, event);
      }

      // Step 4: Update confirmations for previous events
      await this.updateEventConfirmations(block.number);

      // Step 5: Try to reconcile orphaned events
      const reconciledCount = await this.reconciliation.reconcileOrphanedEvents(
        block.number,
      );
      if (reconciledCount.length > 0) {
        this.logger.log(
          `Reconciled ${reconciledCount.length} orphaned events`,
        );
      }

      // Step 6: Update chain state
      await this.stateService.updateChainState({
        lastProcessedBlock: block.number,
        lastCanonicalHash: block.hash,
        confirmedDepth: this.reorgDetector.getConfirmationDepth(),
      });

      this.logger.log(`Block ${block.number} processed successfully`);
    } catch (error) {
      this.logger.error(`Error processing block ${block.number}: ${error}`, error);
      throw error;
    }
  }

  /**
   * Index a single event as pending
   */
  private async indexEvent(block: BlockInfo, event: any): Promise<void> {
    const eventId = `${block.hash}:${event.transactionHash}:${event.logIndex}`;

    const pendingEvent: PendingEvent = {
      id: eventId,
      blockNumber: block.number,
      blockHash: block.hash,
      eventType: event.type || 'unknown',
      data: event.data || {},
      transactionHash: event.transactionHash,
      logIndex: event.logIndex || 0,
      status: 'pending',
      confirmations: 0,
      createdAt: new Date(),
    };

    await this.stateService.savePendingEvent(pendingEvent);
    this.logger.debug(
      `Indexed event: ${eventId} (status: pending)`,
    );
  }

  /**
   * Update confirmation counts for all events
   */
  private async updateEventConfirmations(currentBlockNumber: number): Promise<void> {
    const pendingEvents = await this.stateService.getPendingEvents();

    for (const event of pendingEvents) {
      const confirmations = await this.reorgDetector.calculateConfirmations(
        event.blockNumber,
        currentBlockNumber,
      );

      const isConfirmed = await this.reorgDetector.isEventConfirmed(
        event.blockNumber,
        currentBlockNumber,
      );

      if (isConfirmed && event.status === 'pending') {
        await this.stateService.updateEventStatus(
          event.id,
          'confirmed',
          confirmations,
        );
        this.logger.debug(
          `Event confirmed: ${event.id} (confirmations: ${confirmations})`,
        );
      } else {
        // Just update confirmation count
        await this.stateService.updateEventStatus(
          event.id,
          event.status,
          confirmations,
        );
      }
    }
  }

  /**
   * Get event status
   */
  async getEventStatus(eventId: string): Promise<PendingEvent | null> {
    return this.stateService.getEvent(eventId);
  }

  /**
   * Get all confirmed events (safe for application use)
   */
  async getConfirmedEvents(): Promise<PendingEvent[]> {
    const allEvents: PendingEvent[] = [];
    const chainState = await this.stateService.getChainState();

    // Simulate getting all events from storage
    // In real implementation, filter from DB
    for (let i = 0; i <= chainState.lastProcessedBlock; i++) {
      const blockEvents = await this.stateService.getEventsByBlock(i);
      allEvents.push(...blockEvents);
    }

    return allEvents.filter((e) => e.status === 'confirmed');
  }

  /**
   * Get stats about the indexing state
   */
  async getIndexingStats(): Promise<{
    lastProcessedBlock: number;
    totalEvents: number;
    confirmedEvents: number;
    pendingEvents: number;
    orphanedEvents: number;
    confirmationDepth: number;
  }> {
    const chainState = await this.stateService.getChainState();
    const pendingEvents = await this.stateService.getPendingEvents();
    const orphanedEvents = await this.stateService.getOrphanedEvents();
    const confirmedEvents = await this.getConfirmedEvents();

    return {
      lastProcessedBlock: chainState.lastProcessedBlock,
      totalEvents: pendingEvents.length + orphanedEvents.length + confirmedEvents.length,
      confirmedEvents: confirmedEvents.length,
      pendingEvents: pendingEvents.length,
      orphanedEvents: orphanedEvents.length,
      confirmationDepth: chainState.confirmedDepth,
    };
  }
}

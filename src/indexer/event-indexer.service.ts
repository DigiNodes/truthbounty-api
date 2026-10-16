import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ethers, EventLog } from 'ethers';
import { IndexedEvent, IndexingState } from '../entities';
import { EventIndexerConfig } from '../config';
import { SpanKind } from '@opentelemetry/api';
import { TracingService } from '../tracing/tracing.service';

/**
 * Core event indexing service
 * Handles event subscription, processing, reorg detection, and idempotency
 */
export class EventIndexerService {
  private logger = new Logger(EventIndexerService.name);
  private provider: ethers.JsonRpcProvider;
  private currentBlockNumber: number = 0;
  private isIndexing: boolean = false;

  constructor(
    private config: EventIndexerConfig,
    private eventRepository: Repository<IndexedEvent>,
    private stateRepository: Repository<IndexingState>,
    private tracingService?: TracingService,
  ) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
  }

  /**
   * Start the indexing service
   * Initializes state and begins polling for events
   */
  async start(): Promise<void> {
    if (this.isIndexing) {
      this.logger.warn('Indexer is already running');
      return;
    }

    this.logger.log('Starting event indexer...');
    this.isIndexing = true;

    try {
      // Initialize indexing state for all configured contracts
      for (const contract of this.config.contracts) {
        for (const event of contract.events) {
          await this.initializeIndexingState(contract.address, event.name);
        }
      }

      // Start the main indexing loop
      this.startIndexingLoop();
    } catch (error) {
      this.logger.error('Failed to start indexer');
      this.isIndexing = false;
      throw error;
    }
  }

  /**
   * Stop the indexing service
   */
  stop(): void {
    this.logger.log('Stopping event indexer...');
    this.isIndexing = false;
  }

  /**
   * Main indexing loop - polls for new events at intervals
   */
  private startIndexingLoop(): void {
    const poll = async () => {
      try {
        if (!this.isIndexing) {
          return;
        }

        await this.runIndexingSpan('indexer.poll', async () => {
        // Get current block number
        const blockNumber = await this.provider.getBlockNumber();
        this.currentBlockNumber = blockNumber;

        // Process all configured contracts
        for (const contract of this.config.contracts) {
          await this.indexContract(contract.address, blockNumber);
        }

        // Check for reorgs and reconcile state
        await this.reconcileReorgs(blockNumber);

        // Retry failed events
        await this.retryFailedEvents();
        });
      } catch {
        this.logger.error('Indexer poll failed');
      } finally {
        // Schedule next poll
        if (this.isIndexing) {
          setTimeout(poll, this.config.pollingIntervalMs);
        }
      }
    };

    poll();
  }

  /**
   * Index all events for a specific contract
   */
  private async indexContract(contractAddress: string, currentBlockNumber: number): Promise<void> {
    try {
      for (const eventConfig of this.config.contracts.find(
        (c) => c.address.toLowerCase() === contractAddress.toLowerCase(),
      )?.events || []) {
        await this.indexEventType(contractAddress, eventConfig, currentBlockNumber);
      }
    } catch {
      this.logger.error('Contract indexing failed');
    }
  }

  /**
   * Index a specific event type from a contract
   */
  private async indexEventType(
    contractAddress: string,
    eventConfig: any,
    currentBlockNumber: number,
  ): Promise<void> {
    return this.runIndexingSpan('indexer.event_batch', () =>
      this.indexEventTypeWithinSpan(
        contractAddress,
        eventConfig,
        currentBlockNumber,
      ),
    );
  }

  private async indexEventTypeWithinSpan(
    contractAddress: string,
    eventConfig: any,
    currentBlockNumber: number,
  ): Promise<void> {
    const state = await this.stateRepository.findOne({
      where: {
        chainId: this.config.chainId,
        contractAddress,
        eventType: eventConfig.name,
      },
    });

    if (!state) {
      this.logger.debug(`No state found for ${contractAddress}:${eventConfig.name}`);
      return;
    }

    const startBlock = state.lastProcessedBlockNumber + 1;
    const endBlock = Math.min(
      startBlock + this.config.blockRangePerBatch - 1,
      currentBlockNumber - this.config.confirmationsRequired,
    );

    if (startBlock > endBlock) {
      // Nothing to process yet
      return;
    }

    try {
      // Fetch events from RPC
      const events = await this.fetchEvents(
        contractAddress,
        eventConfig.signature,
        startBlock,
        endBlock,
      );

      // Process each event
      for (const event of events) {
        await this.processEvent(contractAddress, eventConfig, event, endBlock);
      }

      // Update state
      state.lastProcessedBlockNumber = endBlock;
      state.lastIndexedAt = new Date();
      state.status = 'idle';
      await this.stateRepository.save(state);

      this.logger.log(
        `Indexed ${events.length} ${eventConfig.name} events from blocks ${startBlock}-${endBlock}`,
      );
    } catch {
      state.status = 'error';
      state.errorMessage = 'Indexing failed';
      await this.stateRepository.save(state);
      this.logger.error('Event batch indexing failed');
    }
  }

  private runIndexingSpan<T>(name: string, operation: () => Promise<T>): Promise<T> {
    if (!this.tracingService) return operation();
    return this.tracingService.runSpan(name, operation, {
      kind: SpanKind.INTERNAL,
    });
  }

  /**
   * Fetch events from RPC using eth_getLogs
   */
  private async fetchEvents(
    contractAddress: string,
    eventSignature: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<EventLog[]> {
    try {
      const logs = await this.provider.getLogs({
        address: contractAddress,
        topics: [eventSignature],
        fromBlock,
        toBlock,
      });

      return logs as EventLog[];
    } catch (error) {
      this.logger.error('Failed to fetch indexed event batch');
      throw error;
    }
  }

  /**
   * Process a single event
   * Validates, normalizes, and stores in database with idempotency
   */
  private async processEvent(
    contractAddress: string,
    eventConfig: any,
    log: EventLog,
    blockNumber: number,
  ): Promise<void> {
    try {
      // Check if event already exists (idempotency)
      const existingEvent = await this.eventRepository.findOne({
        where: {
          transactionHash: log.transactionHash,
          logIndex: log.index,
          eventType: eventConfig.name,
        },
      });

      if (existingEvent) {
        this.logger.debug(
          `Event already processed: ${log.transactionHash}:${log.index}`,
        );
        return;
      }

      // Decode event data
      const iface = new ethers.Interface([eventConfig.abi]);
      const parsed = iface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });

      // Get block details for confirmation count
      const block = await this.provider.getBlock(log.blockNumber);
      const confirmations = block ? blockNumber - block.number : 0;

      // Store event
      const event = this.eventRepository.create({
        eventType: eventConfig.name,
        contractAddress,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.index,
        chainId: this.config.chainId,
        eventData: log,
        parsedData: parsed?.args || {},
        confirmations,
        isFinalized: confirmations >= this.config.confirmationsRequired,
        isProcessed: false,
        processingError: null,
        retryAttempts: 0,
      });

      await this.eventRepository.save(event);

      this.logger.debug(
        `Stored event: ${eventConfig.name} from ${contractAddress}:${log.blockNumber}:${log.index}`,
      );
    } catch {
      this.logger.error('Failed to process indexed contract event');
    }
  }

  /**
   * Detect and handle chain reorgs
   * Invalidates events that have become unfinalized due to chain reorg
   */
  private async reconcileReorgs(currentBlockNumber: number): Promise<void> {
    try {
      // Find all finalized events
      const finalizedEvents = await this.eventRepository.find({
        where: { isFinalized: true },
      });

      for (const event of finalizedEvents) {
        const confirmations = currentBlockNumber - event.blockNumber;

        // If an event falls below confirmation threshold, it may have been reorged
        if (confirmations < this.config.confirmationsRequired) {
          this.logger.warn(
            `Potential reorg detected for event ${event.transactionHash}:${event.logIndex}`,
          );
          event.isFinalized = false;
          event.isProcessed = false;
          event.processingError = null;
          event.retryAttempts = 0;
          await this.eventRepository.save(event);
        }
      }
    } catch {
      this.logger.error('Indexer reorg reconciliation failed');
    }
  }

  /**
   * Retry failed events up to maxRetryAttempts
   */
  private async retryFailedEvents(): Promise<void> {
    try {
      const failedEvents = await this.eventRepository.find({
        where: {
          isProcessed: false,
          retryAttempts: this.config.maxRetryAttempts,
        },
      });

      // Could implement retry logic here
      // For now, just log
      if (failedEvents.length > 0) {
        this.logger.warn(`${failedEvents.length} events failed after max retries`);
      }
    } catch (error) {
      this.logger.error('Indexer retry scan failed');
    }
  }

  /**
   * Initialize indexing state for a contract event
   */
  private async initializeIndexingState(
    contractAddress: string,
    eventType: string,
  ): Promise<void> {
    const contract = this.config.contracts.find(
      (c) => c.address.toLowerCase() === contractAddress.toLowerCase(),
    );

    if (!contract) {
      return;
    }

    let state = await this.stateRepository.findOne({
      where: {
        chainId: this.config.chainId,
        contractAddress,
        eventType,
      },
    });

    if (!state) {
      state = this.stateRepository.create({
        chainId: this.config.chainId,
        contractAddress,
        eventType,
        lastProcessedBlockNumber: contract.startBlock - 1,
        lastScannedBlockNumber: contract.startBlock - 1,
        status: 'idle',
        blockRangePerBatch: this.config.blockRangePerBatch,
        confirmationsRequired: this.config.confirmationsRequired,
        maxRetryAttempts: this.config.maxRetryAttempts,
      });

      await this.stateRepository.save(state);
      this.logger.log(
        `Initialized state for ${contractAddress}:${eventType} from block ${contract.startBlock}`,
      );
    }
  }

  /**
   * Get current indexing status
   */
  async getStatus(): Promise<Record<string, any>> {
    const states = await this.stateRepository.find();
    return {
      isRunning: this.isIndexing,
      currentBlockNumber: this.currentBlockNumber,
      indexingStates: states.map((s) => ({
        contractAddress: s.contractAddress,
        eventType: s.eventType,
        lastProcessedBlock: s.lastProcessedBlockNumber,
        status: s.status,
        totalEvents: s.totalEventCount,
        processedEvents: s.processedEventCount,
        failedEvents: s.failedEventCount,
      })),
    };
  }

  /**
   * Backfill events from a specific block
   */
  async backfillFromBlock(contractAddress: string, blockNumber: number): Promise<void> {
    const state = await this.stateRepository.findOne({
      where: {
        chainId: this.config.chainId,
        contractAddress,
      },
    });

    if (!state) {
      throw new Error(`No state found for contract ${contractAddress}`);
    }

    state.lastProcessedBlockNumber = blockNumber - 1;
    state.status = 'backfilling';
    await this.stateRepository.save(state);

    this.logger.log(`Backfilling from block ${blockNumber} for ${contractAddress}`);
  }
}

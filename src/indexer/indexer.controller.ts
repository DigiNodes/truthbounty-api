import { Controller, Get, Post, Body, Logger } from '@nestjs/common';
import { EventIndexerService } from './event-indexer.service';

interface BackfillRequest {
  contractAddress: string;
  blockNumber: number;
}

/**
 * REST API for managing the event indexer
 * Provides endpoints for status, restart, and backfill operations
 */
@Controller('indexer')
export class IndexerController {
  private logger = new Logger(IndexerController.name);

  constructor(private eventIndexerService: EventIndexerService) {}

  /**
   * Get current indexer status
   */
  @Get('status')
  async getStatus(): Promise<any> {
    try {
      const status = await this.eventIndexerService.getStatus();
      return {
        success: true,
        data: status,
      };
    } catch (error) {
      this.logger.error('Error getting status:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Restart the indexer
   */
  @Post('restart')
  async restart(): Promise<any> {
    try {
      this.eventIndexerService.stop();
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
      await this.eventIndexerService.start();

      return {
        success: true,
        message: 'Indexer restarted successfully',
      };
    } catch (error) {
      this.logger.error('Error restarting indexer:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Backfill events from a specific block
   */
  @Post('backfill')
  async backfill(@Body() request: BackfillRequest): Promise<any> {
    try {
      const { contractAddress, blockNumber } = request;

      if (!contractAddress || !blockNumber) {
        return {
          success: false,
          error: 'contractAddress and blockNumber are required',
        };
      }

      await this.eventIndexerService.backfillFromBlock(contractAddress, blockNumber);

      return {
        success: true,
        message: `Backfill started from block ${blockNumber} for contract ${contractAddress}`,
      };
    } catch (error) {
      this.logger.error('Error initiating backfill:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

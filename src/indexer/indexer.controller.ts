import {
  Controller,
  Get,
  Post,
  Body,
  Logger,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { EventIndexerService } from './event-indexer.service';
import { IndexerConfigService } from '../config';

interface BackfillRequest {
  contractAddress: string;
  chainId?: number;
  blockNumber: number;
}

/**
 * REST API for managing the event indexer.
 *
 * V2-BE-125 fix 1.6: POST /indexer/backfill now validates that the requested
 * `blockNumber` is >= the canonical deployment block recorded in
 * `v2_contract_artifacts` for the given contract and chain. Requests that
 * predate the contract's on-chain genesis are rejected with HTTP 400.
 */
@ApiTags('indexer')
@Controller('indexer')
export class IndexerController {
  private readonly logger = new Logger(IndexerController.name);

  constructor(
    private readonly eventIndexerService: EventIndexerService,
    private readonly indexerConfigService: IndexerConfigService,
  ) {}

  /** Get current indexer status. */
  @Get('status')
  @ApiOperation({ summary: 'Get current indexer status' })
  async getStatus(): Promise<any> {
    try {
      const status = await this.eventIndexerService.getStatus();
      return { success: true, data: status };
    } catch (error) {
      this.logger.error('Error getting status:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Restart the indexer.
   * Waits 1 s for in-flight operations to settle before re-starting,
   * preserving regression requirement 3.10.
   */
  @Post('restart')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restart the indexer from the persisted checkpoint' })
  async restart(): Promise<any> {
    try {
      this.eventIndexerService.stop();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await this.eventIndexerService.start();
      return { success: true, message: 'Indexer restarted successfully' };
    } catch (error) {
      this.logger.error('Error restarting indexer:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Backfill events from a specific block.
   *
   * Fix 1.6: validates that `blockNumber` >= the deployment block recorded in
   * `v2_contract_artifacts`. Returns HTTP 400 when the requested block
   * predates the contract's canonical deployment block, preventing a backfill
   * window that would span non-existent contract history.
   */
  @Post('backfill')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Backfill events from a specific block' })
  @ApiResponse({ status: 400, description: 'blockNumber predates contract deployment' })
  async backfill(@Body() request: BackfillRequest): Promise<any> {
    const { contractAddress, blockNumber } = request;

    if (!contractAddress || blockNumber == null) {
      throw new BadRequestException('contractAddress and blockNumber are required');
    }

    if (!Number.isInteger(blockNumber) || blockNumber < 0) {
      throw new BadRequestException('blockNumber must be a non-negative integer');
    }

    // Fix 1.6: reject if blockNumber precedes the contract's deployment block.
    const indexerConfig = this.indexerConfigService.getEventIndexerConfig();
    const chainId = request.chainId ?? indexerConfig.chainId;

    const deploymentBlock = await this.eventIndexerService.getDeploymentBlock(
      chainId,
      contractAddress,
    );

    if (deploymentBlock !== null && BigInt(blockNumber) < deploymentBlock) {
      throw new BadRequestException(
        `blockNumber ${blockNumber} predates the canonical deployment block ` +
          `${deploymentBlock.toString()} for contract ${contractAddress} on chain ${chainId}. ` +
          `Backfill must start at or after the contract's deployment block.`,
      );
    }

    try {
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

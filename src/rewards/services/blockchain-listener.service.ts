import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { RewardSyncService } from './reward-sync.service';
import { RewardClaimEventDto } from '../dto/reward-claim-event.dto';
import { RewardDistributionEventDto } from '../dto/reward-distribution-event.dto';

@Injectable()
export class BlockchainListenerService implements OnModuleInit {
  private readonly logger = new Logger(BlockchainListenerService.name);
  private provider: ethers.JsonRpcProvider;
  private contract: ethers.Contract;
  private isListening = false;

  // Your contract ABI (add your actual ABI here)
  private readonly CONTRACT_ABI = [
    'event RewardClaimed(address indexed user, uint256 amount, string claimId)',
    'event RewardDistributed(address[] recipients, uint256[] amounts, string distributionId)',
  ];

  constructor(
    private readonly configService: ConfigService,
    private readonly rewardSyncService: RewardSyncService,
  ) {}

  async onModuleInit() {
    await this.initializeProvider();
    await this.backfillHistoricalEvents();
    this.startListening();
  }

  private async initializeProvider() {
    const rpcUrl = this.configService.get<string>('BLOCKCHAIN_RPC_URL');
    const contractAddress = this.configService.get<string>(
      'REWARD_CONTRACT_ADDRESS',
    );

    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.contract = new ethers.Contract(
      contractAddress,
      this.CONTRACT_ABI,
      this.provider,
    );

    this.logger.log(`Connected to blockchain at ${rpcUrl}`);
    this.logger.log(`Monitoring contract: ${contractAddress}`);
  }

  /**
   * Backfill historical events from the last synced block
   */
  private async backfillHistoricalEvents() {
    const lastSyncedBlock = await this.rewardSyncService.getLastSyncedBlock();
    const currentBlock = await this.provider.getBlockNumber();
    const startBlock =
      lastSyncedBlock || this.configService.get<number>('START_BLOCK', 0);

    if (startBlock >= currentBlock) {
      this.logger.log('No historical events to backfill');
      return;
    }

    this.logger.log(
      `Backfilling events from block ${startBlock} to ${currentBlock}`,
    );

    // Process in chunks to avoid RPC limits
    const CHUNK_SIZE = 10000;
    for (
      let fromBlock = startBlock;
      fromBlock <= currentBlock;
      fromBlock += CHUNK_SIZE
    ) {
      const toBlock = Math.min(fromBlock + CHUNK_SIZE - 1, currentBlock);
      await this.processBlockRange(fromBlock, toBlock);
    }

    this.logger.log('Historical backfill complete');
  }

  private async processBlockRange(fromBlock: number, toBlock: number) {
    try {
      // Query RewardClaimed events
      const claimFilter = this.contract.filters.RewardClaimed();
      const claimEvents = await this.contract.queryFilter(
        claimFilter,
        fromBlock,
        toBlock,
      );

      for (const event of claimEvents) {
        await this.handleRewardClaimedEvent(event);
      }

      // Query RewardDistributed events
      const distFilter = this.contract.filters.RewardDistributed();
      const distEvents = await this.contract.queryFilter(
        distFilter,
        fromBlock,
        toBlock,
      );

      for (const event of distEvents) {
        await this.handleRewardDistributedEvent(event);
      }

      this.logger.log(
        `Processed blocks ${fromBlock}-${toBlock}: ${claimEvents.length} claims, ${distEvents.length} distributions`,
      );
    } catch (error) {
      this.logger.error(
        `Error processing block range ${fromBlock}-${toBlock}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Start listening to new events in real-time
   */
  private startListening() {
    if (this.isListening) return;

    this.contract.on('RewardClaimed', async (...args) => {
      const event = args[args.length - 1];
      await this.handleRewardClaimedEvent(event);
    });

    this.contract.on('RewardDistributed', async (...args) => {
      const event = args[args.length - 1];
      await this.handleRewardDistributedEvent(event);
    });

    this.isListening = true;
    this.logger.log('Started listening for blockchain events');
  }

  private async handleRewardClaimedEvent(event: ethers.EventLog) {
    try {
      const block = await event.getBlock();

      const eventDto: RewardClaimEventDto = {
        walletAddress: event.args.user,
        amount: event.args.amount.toString(),
        claimId: event.args.claimId,
        txHash: event.transactionHash,
        blockNumber: event.blockNumber,
        logIndex: event.index,
        blockTimestamp: block.timestamp,
        eventName: 'RewardClaimed',
      };

      await this.rewardSyncService.processRewardClaim(eventDto);
    } catch (error) {
      this.logger.error(`Error handling RewardClaimed event:`, error);
    }
  }

  private async handleRewardDistributedEvent(event: ethers.EventLog) {
    try {
      const block = await event.getBlock();

      const eventDto: RewardDistributionEventDto = {
        recipients: event.args.recipients,
        amounts: event.args.amounts.map((a: bigint) => a.toString()),
        distributionId: event.args.distributionId,
        txHash: event.transactionHash,
        blockNumber: event.blockNumber,
        logIndex: event.index,
        blockTimestamp: block.timestamp,
        eventName: 'RewardDistributed',
      };

      await this.rewardSyncService.processRewardDistribution(eventDto);
    } catch (error) {
      this.logger.error(`Error handling RewardDistributed event:`, error);
    }
  }

  /**
   * Manually trigger a sync for a specific block range
   */
  async syncBlockRange(fromBlock: number, toBlock: number): Promise<void> {
    await this.processBlockRange(fromBlock, toBlock);
  }
}

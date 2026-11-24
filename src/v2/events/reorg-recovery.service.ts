import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventCheckpoint } from './entities/event-checkpoint.entity';
import { ReorgRollbackService } from './reorg-rollback.service';
import { ReorgRecoveryStatus, ReorgRecoveryStatusSnapshot } from './interfaces/reorg-recovery.interface';

@Injectable()
export class ReorgRecoveryService {
  private readonly logger = new Logger(ReorgRecoveryService.name);
  
  // The maximum depth we are willing to rollback. Beyond this, we stop.
  public static readonly MAX_REORG_HORIZON = 64;
  
  // In-memory status tracking. In a multi-replica setup, this should be Redis-backed.
  private statusMap = new Map<number, ReorgRecoveryStatusSnapshot>();

  constructor(
    @InjectRepository(EventCheckpoint)
    private readonly checkpointRepo: Repository<EventCheckpoint>,
    private readonly rollbackService: ReorgRollbackService,
  ) {}

  /**
   * Detects if a reorg occurred by comparing the incoming block hash
   * against the checkpoint's recorded hash.
   */
  async detectAndRecover(
    chainId: number,
    contractAddress: string,
    incomingSafeBlock: bigint,
    incomingSafeBlockHash: string,
    incomingParentHash: string,
    newLogs: any[] = [],
  ): Promise<void> {
    const checkpoint = await this.checkpointRepo.findOne({
      where: { chainId, contractAddress: contractAddress.toLowerCase() },
    });

    if (!checkpoint) return; // Nothing to rollback

    // If the incoming block is the direct child of our finalized block, no reorg.
    if (checkpoint.lastFinalizedBlockHash === incomingParentHash) {
      // Update checkpoint with new hashes and advance block numbers
      checkpoint.lastSafeBlock = incomingSafeBlock.toString();
      checkpoint.lastSafeBlockHash = incomingSafeBlockHash;
      // (Assuming we finalize immediately for this example; in reality it lags)
      checkpoint.lastFinalizedBlock = incomingSafeBlock.toString();
      checkpoint.lastFinalizedBlockHash = incomingSafeBlockHash;
      await this.checkpointRepo.save(checkpoint);
      return;
    }

    // ── REORG DETECTED ──
    this.logger.warn(`Reorg detected on chain ${chainId}. Starting recovery.`);
    
    const reorgDepth = Number(incomingSafeBlock) - Number(checkpoint.lastFinalizedBlock);
    
    this.setStatus(chainId, {
      status: ReorgRecoveryStatus.ROLLING_BACK,
      chainId,
      detectedAt: new Date(),
      recoveredAt: null,
      forkBlockHash: checkpoint.lastFinalizedBlockHash,
      forkBlockNumber: checkpoint.lastFinalizedBlock,
      reorgDepth,
      reason: 'Parent hash mismatch',
    });

    if (reorgDepth > ReorgRecoveryService.MAX_REORG_HORIZON) {
      this.logger.error(`Deep reorg exceeded horizon (${reorgDepth} > ${ReorgRecoveryService.MAX_REORG_HORIZON}). Stopping readiness.`);
      this.setStatus(chainId, {
        status: ReorgRecoveryStatus.STOPPED_DEEP_REORG,
        chainId,
        detectedAt: new Date(),
        recoveredAt: null,
        forkBlockHash: checkpoint.lastFinalizedBlockHash,
        forkBlockNumber: checkpoint.lastFinalizedBlock,
        reorgDepth,
        reason: 'Deep reorg exceeded supported horizon',
      });
      throw new Error(`Deep reorg detected: depth ${reorgDepth} exceeds horizon. Manual intervention required.`);
    }

    try {
      // 1. Rollback using the existing service
      await this.rollbackService.rollback(
        chainId,
        incomingSafeBlock, 
        contractAddress
      );

      // 2. Replay new canonical chain
      this.setStatus(chainId, {
        status: ReorgRecoveryStatus.REPLAYING,
        chainId,
        detectedAt: new Date(),
        recoveredAt: null,
        forkBlockHash: checkpoint.lastFinalizedBlockHash,
        forkBlockNumber: checkpoint.lastFinalizedBlock,
        reorgDepth,
        reason: 'Replaying new canonical branch',
      });
      
      await this.rollbackService.reapplyLogs(newLogs);

      // 3. Mark recovered
      checkpoint.lastSafeBlock = incomingSafeBlock.toString();
      checkpoint.lastSafeBlockHash = incomingSafeBlockHash;
      checkpoint.lastFinalizedBlock = incomingSafeBlock.toString();
      checkpoint.lastFinalizedBlockHash = incomingSafeBlockHash;
      await this.checkpointRepo.save(checkpoint);

      this.setStatus(chainId, {
        status: ReorgRecoveryStatus.RECOVERED,
        chainId,
        detectedAt: null,
        recoveredAt: new Date(),
        forkBlockHash: null,
        forkBlockNumber: null,
        reorgDepth,
        reason: 'Recovery complete',
      });
    } catch (err) {
      this.logger.error(`Recovery failed: ${(err as Error).message}`);
      this.setStatus(chainId, {
        status: ReorgRecoveryStatus.STOPPED_AMBIGUOUS,
        chainId,
        detectedAt: new Date(),
        recoveredAt: null,
        forkBlockHash: checkpoint.lastFinalizedBlockHash,
        forkBlockNumber: checkpoint.lastFinalizedBlock,
        reorgDepth,
        reason: 'Recovery execution failed',
      });
      throw err;
    }
  }

  getStatus(chainId: number): ReorgRecoveryStatusSnapshot {
    return this.statusMap.get(chainId) ?? {
      status: ReorgRecoveryStatus.HEALTHY,
      chainId,
      detectedAt: null,
      recoveredAt: null,
      forkBlockHash: null,
      forkBlockNumber: null,
      reorgDepth: null,
      reason: null,
    };
  }

  private setStatus(chainId: number, snapshot: ReorgRecoveryStatusSnapshot) {
    this.statusMap.set(chainId, snapshot);
  }
}

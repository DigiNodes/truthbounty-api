import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectRewardPool } from './entities/project-reward-pool.entity';
import { ProjectRewardAllocation } from './entities/project-reward-allocation.entity';
import { ProjectRewardClaim } from './entities/project-reward-claim.entity';
import { EventCheckpoint } from '../events/entities/event-checkpoint.entity';
import { ProjectVerificationRound } from '../verification/entities/project-verification-round.entity';
import { ProjectDispute, DisputeStatus } from '../disputes/entities/project-dispute.entity';
import { BlockchainStateService } from '../../blockchain/state.service';
import { FinalityPolicyService } from '../../config/finality-policy.service';
import { DataState } from '../common/data-state.enum';
import { StaleReconciliationException } from './exceptions/stale-reconciliation.exception';
import {
  SettlementProjectionResponseDto,
  AssetMetadataDto,
  FinalityMetadataDto,
  ProvenanceMetadataDto,
} from './dto/settlement-projection-response.dto';
import {
  calculateExactSettlementValues,
  CanonicalSettlementState,
  ROUNDING_POLICY,
  toBigIntSafe,
} from './settlement-projection.types';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';
import { AllocationKind } from './reward-allocation-kind.enum';

export const CANONICAL_RELEASE_METADATA = {
  releaseVersion: 'v2.0.0-sepolia',
  protocolVersion: '2.0.0',
  abiVersion: '2.0.0',
  chainId: 11155420,
  network: 'optimism-sepolia',
  manifestChecksum: 'f183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22f',
  tokenAddress: '0x0000000000000000000000000000000000001004',
  tokenSymbol: 'TRUTH',
  tokenName: 'TruthBounty Staking Token',
  tokenDecimals: 18,
} as const;

export const AUTHORITY_DISCLAIMER =
  'Canonical finalized contract events remain authoritative. API projections are informational and non-authoritative.';

const ALLOWED_CHAIN_IDS = [10, 11155420];
const DEFAULT_MAX_LAG_BLOCKS = 50;

@Injectable()
export class SettlementProjectionService {
  private readonly logger = new Logger(SettlementProjectionService.name);

  constructor(
    @InjectRepository(ProjectRewardPool)
    private readonly poolRepo: Repository<ProjectRewardPool>,
    @InjectRepository(ProjectRewardAllocation)
    private readonly allocationRepo: Repository<ProjectRewardAllocation>,
    @InjectRepository(ProjectRewardClaim)
    private readonly claimRepo: Repository<ProjectRewardClaim>,
    @InjectRepository(EventCheckpoint)
    private readonly checkpointRepo: Repository<EventCheckpoint>,
    @InjectRepository(ProjectVerificationRound)
    private readonly roundRepo: Repository<ProjectVerificationRound>,
    @InjectRepository(ProjectDispute)
    private readonly disputeRepo: Repository<ProjectDispute>,
    @Optional() private readonly blockchainState?: BlockchainStateService,
    @Optional() private readonly finalityPolicy?: FinalityPolicyService,
  ) {}

  /**
   * Get exact reward, claimable, and settlement projections for a claim.
   *
   * Enforces:
   * 1. Exact 256-bit integer calculations (no floats).
   * 2. Strict segregation of pending, claimable, and claimed (paid).
   * 3. Non-authoritative estimate labeling with canonical disclaimer.
   * 4. Conservation reconciliation (funded = claimed + claimable + pending + slashed + dust).
   * 5. Provenance binding to release manifest (v2.0.0-sepolia, chain 11155420).
   * 6. Fail-closed on stale, unauthorized, or ambiguous state.
   */
  async getClaimSettlementProjection(
    claimId: string,
    options?: { chainId?: number; maxLagBlocks?: number },
  ): Promise<SettlementProjectionResponseDto> {
    if (!claimId || claimId.trim() === '') {
      throw new BadRequestException('claimId is required');
    }

    const chainId = options?.chainId ?? CANONICAL_RELEASE_METADATA.chainId;
    if (!ALLOWED_CHAIN_IDS.includes(chainId)) {
      throw new BadRequestException(`Unsupported chainId: ${chainId}`);
    }

    // 1. Check freshness fail-closed
    await this.assertFreshness(chainId, options?.maxLagBlocks ?? DEFAULT_MAX_LAG_BLOCKS);

    // 2. Fetch chain data for this claim
    const pools = await this.poolRepo.find({
      where: { chainId, claimId },
      order: { blockNumber: 'ASC', eventLogIndex: 'ASC' },
    });

    const allocations = await this.allocationRepo.find({
      where: { chainId, claimId },
      order: { allocationId: 'ASC' },
    });

    const claims = await this.claimRepo.find({
      where: { chainId, claimId },
      order: { claimTxHash: 'ASC', claimLogIndex: 'ASC' },
    });

    const dispute = await this.disputeRepo.findOne({
      where: { claimId },
      order: { blockNumber: 'DESC' },
    });

    const rounds = await this.roundRepo.find({
      where: { claimId },
      order: { openedAtBlock: 'DESC' },
    });

    // Check existence: if no pools, allocations, rounds, or claims exist, claim is not found
    if (
      pools.length === 0 &&
      allocations.length === 0 &&
      rounds.length === 0 &&
      claims.length === 0
    ) {
      throw new NotFoundException(`Claim ${claimId} not found`);
    }

    // 3. Finality evaluation
    const checkpoint = await this.checkpointRepo.findOne({
      where: { chainId },
      order: { updatedAt: 'DESC' },
    });

    // Identify highest block associated with claim settlement
    let highestBlock = 0n;
    for (const p of pools) {
      const b = BigInt(p.blockNumber);
      if (b > highestBlock) highestBlock = b;
    }
    for (const a of allocations) {
      const b = BigInt(a.blockNumber);
      if (b > highestBlock) highestBlock = b;
      if (a.lastClaimBlockNumber) {
        const cb = BigInt(a.lastClaimBlockNumber);
        if (cb > highestBlock) highestBlock = cb;
      }
    }
    for (const c of claims) {
      const b = BigInt(c.blockNumber);
      if (b > highestBlock) highestBlock = b;
    }

    let dataState = DataState.OBSERVED;
    if (this.finalityPolicy && checkpoint) {
      dataState = this.finalityPolicy.classifyByCheckpoint(highestBlock.toString(), checkpoint);
    } else if (checkpoint && highestBlock > 0n) {
      const lastFinalized = BigInt(checkpoint.lastFinalizedBlock);
      const lastSafe = BigInt(checkpoint.lastSafeBlock);
      if (highestBlock <= lastFinalized) {
        dataState = DataState.FINALIZED;
      } else if (highestBlock <= lastSafe) {
        dataState = DataState.SAFE;
      }
    }

    const isFinalized = dataState === DataState.FINALIZED;

    // Check whether an active dispute or unfinalized appeal blocks claimability
    const isDisputed = dispute?.status === DisputeStatus.RAISED;

    // 4. Calculate exact settlement accounting
    let totalFunded = 0n;
    for (const p of pools) {
      totalFunded += toBigIntSafe(p.poolAmount, 'poolAmount');
    }

    const allocationItems = allocations.map((a) => ({
      allocationId: a.allocationId,
      kind: a.kind,
      beneficiary: a.beneficiary,
      allocatedAmount: a.allocatedAmount,
      claimedAmount: a.claimedAmount,
      isFinalized,
      isDisputed,
    }));

    // If challenge bond was slashed in dispute, account for slashed amount
    let slashed = 0n;
    if (dispute?.status === DisputeStatus.RESOLVED && dispute.challengeBond) {
      if (dispute.resolvedOutcome === 'REJECTED') {
        slashed += toBigIntSafe(dispute.challengeBond, 'challengeBond');
      }
    }

    const { values, conservation, allocatedBreakdown } = calculateExactSettlementValues({
      fundedAmount: totalFunded.toString(),
      allocations: allocationItems,
      slashedAmount: slashed.toString(),
    });

    // 5. Derive canonical settlement state
    const settlementState = this.deriveSettlementState(pools.length > 0, allocations, dispute, isFinalized);

    // 6. Build metadata
    const assetMeta: AssetMetadataDto = {
      address: pools[0]?.asset ?? CANONICAL_RELEASE_METADATA.tokenAddress,
      symbol: CANONICAL_RELEASE_METADATA.tokenSymbol,
      decimals: CANONICAL_RELEASE_METADATA.tokenDecimals,
      name: CANONICAL_RELEASE_METADATA.tokenName,
      chainId,
    };

    const finalityMeta: FinalityMetadataDto = {
      dataState,
      confirmations: checkpoint && highestBlock > 0n
        ? Math.max(0, Number(BigInt(checkpoint.lastIndexedBlock) - highestBlock))
        : 0,
      blockNumber: highestBlock.toString(),
      finalizedHeight: checkpoint?.lastFinalizedBlock?.toString() ?? null,
      safeHeight: checkpoint?.lastSafeBlock?.toString() ?? null,
      isFinalized,
      isAuthoritative: false, // Never authoritative from API projection
    };

    const provenanceMeta: ProvenanceMetadataDto = {
      releaseVersion: CANONICAL_RELEASE_METADATA.releaseVersion,
      protocolVersion: CANONICAL_RELEASE_METADATA.protocolVersion,
      abiVersion: CANONICAL_RELEASE_METADATA.abiVersion,
      chainId,
      network: CANONICAL_RELEASE_METADATA.network,
      manifestChecksum: CANONICAL_RELEASE_METADATA.manifestChecksum,
      contractAddress: assetMeta.address,
      settlementBlock: highestBlock > 0n ? highestBlock.toString() : undefined,
    };

    return {
      claimId,
      settlementState,
      isEstimate: !isFinalized,
      isAuthoritative: false,
      authorityDisclaimer: AUTHORITY_DISCLAIMER,
      values,
      conservation,
      asset: assetMeta,
      finality: finalityMeta,
      provenance: provenanceMeta,
      allocations: allocatedBreakdown,
      projectionsGeneratedAt: new Date().toISOString(),
    };
  }

  /**
   * Replay an arbitrary list of canonical events in memory and verify custody conservation.
   */
  async replayAndReconcile(
    claimId: string,
    events: CanonicalEvent[],
  ): Promise<{
    values: any;
    conservation: any;
    appliedCount: number;
  }> {
    let funded = 0n;
    const allocationsMap = new Map<string, {
      allocationId: string;
      kind: AllocationKind;
      beneficiary: string | null;
      allocatedAmount: bigint;
      claimedAmount: bigint;
    }>();
    let slashed = 0n;

    let appliedCount = 0;

    for (const event of events) {
      if (event.claimId && event.claimId !== claimId) continue;

      if (event.eventName === 'RewardPoolSettled' || event.eventName === 'RewardFunded') {
        const amount = toBigIntSafe(event.amount ?? (event.payload?.amount as string), 'amount');
        funded += amount;
        appliedCount++;
      } else if (event.eventName === 'RewardAllocated') {
        const allocId = (event.payload?.allocationId as string) ?? `${event.txHash}:${event.logIndex}`;
        const kind = (event.payload?.kind as AllocationKind) ?? AllocationKind.VERIFIER;
        const beneficiary = event.actor ?? (event.payload?.beneficiary as string) ?? null;
        const amount = toBigIntSafe(event.amount ?? (event.payload?.amount as string), 'amount');

        allocationsMap.set(allocId, {
          allocationId: allocId,
          kind,
          beneficiary,
          allocatedAmount: amount,
          claimedAmount: 0n,
        });
        appliedCount++;
      } else if (event.eventName === 'RewardClaimed') {
        const allocId = (event.payload?.allocationId as string);
        const amount = toBigIntSafe(event.amount ?? (event.payload?.amount as string), 'amount');

        if (allocId && allocationsMap.has(allocId)) {
          const entry = allocationsMap.get(allocId)!;
          // Prevent over-claim
          if (entry.claimedAmount + amount <= entry.allocatedAmount) {
            entry.claimedAmount += amount;
            appliedCount++;
          }
        } else {
          // If no allocId, match earliest with available allocation
          for (const entry of allocationsMap.values()) {
            if (entry.claimedAmount + amount <= entry.allocatedAmount) {
              entry.claimedAmount += amount;
              appliedCount++;
              break;
            }
          }
        }
      } else if (event.eventName === 'RewardSlashed' || event.eventName === 'StakeSlashed') {
        const amount = toBigIntSafe(event.amount ?? (event.payload?.amount as string), 'amount');
        slashed += amount;
        appliedCount++;
      }
    }

    const allocationItems = Array.from(allocationsMap.values()).map((a) => ({
      allocationId: a.allocationId,
      kind: a.kind,
      beneficiary: a.beneficiary,
      allocatedAmount: a.allocatedAmount.toString(),
      claimedAmount: a.claimedAmount.toString(),
      isFinalized: true,
      isDisputed: false,
    }));

    const result = calculateExactSettlementValues({
      fundedAmount: funded.toString(),
      allocations: allocationItems,
      slashedAmount: slashed.toString(),
    });

    return {
      values: result.values,
      conservation: result.conservation,
      appliedCount,
    };
  }

  /**
   * Fail closed if indexer lag exceeds threshold.
   */
  private async assertFreshness(chainId: number, maxLag: number): Promise<void> {
    if (this.blockchainState) {
      try {
        const health = await this.blockchainState.getIndexerHealth();
        if (health.indexerLagBlocks > maxLag || health.status === 'unhealthy') {
          throw new StaleReconciliationException(
            health.observedHeadBlock,
            health.projectionHeadBlock,
            health.indexerLagBlocks,
          );
        }
      } catch (err) {
        if (err instanceof StaleReconciliationException) throw err;
        this.logger.warn(`BlockchainStateService health check error: ${err}`);
      }
    }

    // Check DB checkpoint lag
    const checkpoint = await this.checkpointRepo.findOne({
      where: { chainId },
      order: { updatedAt: 'DESC' },
    });

    if (checkpoint) {
      const lastIndexed = Number(checkpoint.lastIndexedBlock);
      const lastFinalized = Number(checkpoint.lastFinalizedBlock);
      const lag = Math.max(0, lastIndexed - lastFinalized);
      if (lag > maxLag * 2) {
        throw new StaleReconciliationException(lastIndexed, lastFinalized, lag);
      }
    }
  }

  /**
   * Derive canonical settlement vocabulary state from read models.
   */
  private deriveSettlementState(
    hasPool: boolean,
    allocations: ProjectRewardAllocation[],
    dispute: ProjectDispute | null,
    isFinalized: boolean,
  ): CanonicalSettlementState {
    if (dispute?.status === DisputeStatus.RAISED) {
      return 'PENDING_APPEAL';
    }

    if (dispute?.appealRoundId) {
      const anyClaimed = allocations.some((a) => a.claimedAmount !== '0');
      return anyClaimed ? 'APPEAL_CLAIMED' : 'APPEAL_SETTLED';
    }

    if (!hasPool && allocations.length === 0) {
      return 'PENDING_SETTLEMENT';
    }

    if (allocations.length > 0) {
      const allClaimed = allocations.every(
        (a) => a.allocatedAmount !== '0' && a.allocatedAmount === a.claimedAmount,
      );
      if (allClaimed) {
        return isFinalized ? 'FINALIZED' : 'SETTLEMENT_CLAIMED';
      }
    }

    if (isFinalized) {
      return 'FINALIZED';
    }

    return hasPool ? 'SETTLED' : 'PENDING_SETTLEMENT';
  }
}

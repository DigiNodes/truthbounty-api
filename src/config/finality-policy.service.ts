import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataState } from '../v2/common/data-state.enum';

export interface FinalityThresholds {
  chainId: number;
  safeConfirmations: number;
  finalizedConfirmations: number;
}

export interface ChainCheckpoint {
  lastSafeBlock: string | number | bigint;
  lastFinalizedBlock: string | number | bigint;
}

/** Upper bound sanity check against a fat-fingered env value (e.g. an extra zero). */
const MAX_SANE_CONFIRMATIONS = 100_000;

/**
 * Single source of truth for finality/confirmations policy: validates the
 * per-environment inputs at startup (fail-closed) and exposes the shared
 * provisional-vs-finalized classification logic that was previously
 * duplicated across VerificationQueryService and DisputesQueryService.
 *
 * This service is read-only and advisory to API responses — it never writes
 * indexing state, never mutates protocol data, and is not authoritative for
 * settlement/rewards/treasury/governance. It only classifies already-indexed
 * block heights into OBSERVED/SAFE/FINALIZED for read-model responses.
 */
@Injectable()
export class FinalityPolicyService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FinalityPolicyService.name);

  constructor(private readonly configService: ConfigService) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.configService.get('FINALITY_POLICY_STARTUP_VALIDATION') === 'false') {
      this.logger.warn('Finality policy startup validation disabled by config');
      return;
    }
    this.validate();
  }

  /**
   * Validate the configured finality inputs. Fail-closed: throws on any
   * invalid value rather than silently falling back to a default, since a
   * bad confirmations threshold in production would silently mislabel
   * provisional data as finalized (or vice versa).
   */
  validate(): FinalityThresholds {
    const thresholds = this.getThresholds();
    const errors: string[] = [];

    if (!Number.isInteger(thresholds.chainId) || thresholds.chainId <= 0) {
      errors.push(`CHAIN_ID must resolve to a positive integer (got "${thresholds.chainId}")`);
    } else if (!this.getAllowedChainIds().includes(thresholds.chainId)) {
      errors.push(
        `CHAIN_ID ${thresholds.chainId} is not a recognized Optimism network (allowed: ${this.getAllowedChainIds().join(', ')})`,
      );
    }

    for (const [name, value] of [
      ['FINALITY_SAFE_CONFIRMATIONS', thresholds.safeConfirmations],
      ['FINALITY_FINALIZED_CONFIRMATIONS', thresholds.finalizedConfirmations],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) {
        errors.push(`${name} must resolve to a non-negative integer (got "${value}")`);
      } else if (value > MAX_SANE_CONFIRMATIONS) {
        errors.push(`${name} exceeds the sane upper bound of ${MAX_SANE_CONFIRMATIONS} (got ${value})`);
      }
    }

    if (
      Number.isInteger(thresholds.safeConfirmations) &&
      Number.isInteger(thresholds.finalizedConfirmations) &&
      thresholds.safeConfirmations > thresholds.finalizedConfirmations
    ) {
      errors.push(
        `safeConfirmations (${thresholds.safeConfirmations}) must be <= finalizedConfirmations (${thresholds.finalizedConfirmations})`,
      );
    }

    if (errors.length > 0) {
      const msg = `Finality policy validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    this.logger.log(
      `Finality policy validated: chainId=${thresholds.chainId} safeConfirmations=${thresholds.safeConfirmations} finalizedConfirmations=${thresholds.finalizedConfirmations}`,
    );
    return thresholds;
  }

  getThresholds(): FinalityThresholds {
    return {
      chainId: this.configService.get<number>('finalityPolicy.chainId', 10),
      safeConfirmations: this.configService.get<number>('finalityPolicy.safeConfirmations', 1),
      finalizedConfirmations: this.configService.get<number>('finalityPolicy.finalizedConfirmations', 12),
    };
  }

  private getAllowedChainIds(): number[] {
    return this.configService.get<number[]>('finalityPolicy.allowedChainIds', [10, 11155420]);
  }

  /**
   * Classify a target block against the current chain head using the
   * validated confirmations thresholds. Pure, deterministic, side-effect-free.
   */
  classifyByConfirmations(targetBlock: bigint, currentBlock: bigint): DataState {
    if (currentBlock < targetBlock) {
      return DataState.OBSERVED;
    }
    const confirmations = currentBlock - targetBlock;
    const { safeConfirmations, finalizedConfirmations } = this.getThresholds();

    if (confirmations >= BigInt(finalizedConfirmations)) {
      return DataState.FINALIZED;
    }
    if (confirmations >= BigInt(safeConfirmations)) {
      return DataState.SAFE;
    }
    return DataState.OBSERVED;
  }

  /**
   * Classify a projected record's block number against a projection
   * checkpoint's last-safe / last-finalized block heights. Pure. This is the
   * single source of truth for the threshold logic that used to be
   * duplicated (identically) in VerificationQueryService and
   * DisputesQueryService.
   */
  classifyByCheckpoint(
    blockNumber: string | number | bigint,
    checkpoint: ChainCheckpoint | null,
  ): DataState {
    if (!checkpoint) {
      return DataState.OBSERVED;
    }

    const blockNum = BigInt(blockNumber);
    const lastSafe = BigInt(checkpoint.lastSafeBlock);
    const lastFinalized = BigInt(checkpoint.lastFinalizedBlock);

    if (blockNum <= lastFinalized) {
      return DataState.FINALIZED;
    }
    if (blockNum <= lastSafe) {
      return DataState.SAFE;
    }
    return DataState.OBSERVED;
  }

  isFinalized(state: DataState): boolean {
    return state === DataState.FINALIZED;
  }

  isProvisional(state: DataState): boolean {
    return state !== DataState.FINALIZED;
  }
}

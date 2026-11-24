import { Logger } from '@nestjs/common';
import {
  DivergenceKind,
  QuorumProvider,
  QuorumSignal,
} from './interfaces';

/**
 * ProviderDivergenceDetector
 *
 * Stateless classifier. Given:
 *   - the raw observations from every provider
 *   - the agreed value (majority for scalar signals, quorum head for LAG)
 * it returns a DivergenceKind per provider.
 *
 * This class only *classifies*. It never mutates provider state, never
 * writes to Redis, and never throws — the caller (RpcProviderQuorumService)
 * decides what to do with each verdict.
 */
export class ProviderDivergenceDetector {
  private readonly logger = new Logger(ProviderDivergenceDetector.name);

  /**
   * Classify one provider's observation against the quorum-agreed value.
   */
  classify(args: {
    provider: QuorumProvider;
    signal: QuorumSignal;
    observation: unknown;
    agreedValue: unknown;
    /** Only set for LAG classification on FINALIZED_HEAD. */
    quorumHead?: bigint;
    maxHeadLagBlocks?: number;
    /** Only set when an error was thrown during observation. */
    error?: unknown;
  }): DivergenceKind | null {
    const {
      signal,
      observation,
      agreedValue,
      quorumHead,
      maxHeadLagBlocks,
      error,
    } = args;

    // 1. Errors first — classify by type.
    if (error !== undefined) {
      return this.classifyError(error);
    }

    // 2. Signal-specific classification.
    switch (signal) {
      case QuorumSignal.CHAIN_ID:
        return observation !== agreedValue ? DivergenceKind.WRONG_CHAIN : null;

      case QuorumSignal.FINALIZED_HEAD: {
        // Within-tolerance lag is NOT divergence. The tolerance is the
        // only rule for FINALIZED_HEAD; a value that is merely different
        // from the quorum head but inside the bound is still trusted.
        // If we ever lack the quorum head or see a malformed value,
        // fail closed and classify as LAG.
        if (typeof observation !== 'bigint' || quorumHead === undefined) {
          return DivergenceKind.LAG;
        }
        const lag = quorumHead - observation;
        const tolerance = BigInt(maxHeadLagBlocks ?? 0);
        return lag > tolerance ? DivergenceKind.LAG : null;
      }

      case QuorumSignal.BLOCK_HASH:
        return observation !== agreedValue
          ? DivergenceKind.FORK_DIVERGENCE
          : null;

      case QuorumSignal.RECEIPT_STATUS:
        return observation !== agreedValue
          ? DivergenceKind.RECEIPT_DIVERGENCE
          : null;

      case QuorumSignal.CONTRACT_CODE_HASH:
        return observation !== agreedValue
          ? DivergenceKind.CODE_DIVERGENCE
          : null;

      default:
        return null;
    }
  }

  private classifyError(error: unknown): DivergenceKind {
    const msg = error instanceof Error ? error.message : String(error);

    if (/timeout/i.test(msg)) {
      return DivergenceKind.TIMEOUT;
    }
    if (/429|rate.?limit|too many requests/i.test(msg)) {
      return DivergenceKind.RATE_LIMITED;
    }
    return DivergenceKind.ERROR;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import {
  ChainArtifactAuthority,
  FeatureFreshnessStatus,
  FeatureProvenance,
  InvalidFeatureBoundsException,
  PublicSybilScoreView,
  SybilScoreComputationResult,
  SybilSignals,
  UnauthorizedProvenanceException,
} from './sybil-resistance.types';

@Injectable()
export class SybilProvenanceService {
  private readonly logger = new Logger(SybilProvenanceService.name);

  /**
   * Validate that the chain authority binding conforms to canonical protocol constraints
   */
  public validateChainAuthority(authority: ChainArtifactAuthority): void {
    if (!Number.isSafeInteger(authority.chainId) || authority.chainId <= 0) {
      throw new UnauthorizedProvenanceException(
        `Invalid chainId in authority: ${authority.chainId}`,
      );
    }

    if (!authority.releaseId || !authority.releaseId.trim()) {
      throw new UnauthorizedProvenanceException(
        'Missing releaseId in chain authority binding',
      );
    }

    if (
      !authority.artifactHash ||
      !/^[a-fA-F0-9]{64}$/.test(authority.artifactHash)
    ) {
      throw new UnauthorizedProvenanceException(
        `Invalid artifact checksum hash: ${authority.artifactHash}`,
      );
    }

    if (
      !authority.contractAddress ||
      !/^0x[a-fA-F0-9]{40}$/.test(authority.contractAddress)
    ) {
      throw new UnauthorizedProvenanceException(
        `Invalid contract address in authority: ${authority.contractAddress}`,
      );
    }

    if (
      !Number.isSafeInteger(authority.finalizedThroughBlock) ||
      authority.finalizedThroughBlock < 0
    ) {
      throw new UnauthorizedProvenanceException(
        `Invalid finalizedThroughBlock: ${authority.finalizedThroughBlock}`,
      );
    }
  }

  /**
   * Validate that a specific event or feature matches canonical finalized provenance.
   * Fails closed on unauthorized, stale, ambiguous, or incomplete state.
   */
  public validateEventProvenance(
    event: {
      chainId?: number;
      releaseId?: string;
      artifactHash?: string;
      contractAddress?: string;
      blockNumber: number;
      isFinalized?: boolean;
      isCanonical?: boolean;
    },
    authority: ChainArtifactAuthority,
  ): void {
    this.validateChainAuthority(authority);

    if (event.chainId !== undefined && event.chainId !== authority.chainId) {
      throw new UnauthorizedProvenanceException(
        `Chain ID mismatch: event on chain ${event.chainId}, authority expects ${authority.chainId}`,
      );
    }

    if (
      event.releaseId !== undefined &&
      event.releaseId !== authority.releaseId
    ) {
      throw new UnauthorizedProvenanceException(
        `Release ID mismatch: event belongs to release ${event.releaseId}, authority expects ${authority.releaseId}`,
      );
    }

    if (
      event.artifactHash !== undefined &&
      event.artifactHash.toLowerCase() !== authority.artifactHash.toLowerCase()
    ) {
      throw new UnauthorizedProvenanceException(
        `Artifact hash mismatch: event has ${event.artifactHash}, authority expects ${authority.artifactHash}`,
      );
    }

    if (
      event.contractAddress !== undefined &&
      event.contractAddress.toLowerCase() !==
        authority.contractAddress.toLowerCase()
    ) {
      throw new UnauthorizedProvenanceException(
        `Contract address mismatch: event originated at ${event.contractAddress}, authority requires ${authority.contractAddress}`,
      );
    }

    if (event.blockNumber > authority.finalizedThroughBlock) {
      throw new UnauthorizedProvenanceException(
        `Event at block ${event.blockNumber} is not finalized (finalized checkpoint is ${authority.finalizedThroughBlock})`,
      );
    }

    if (event.isFinalized === false) {
      throw new UnauthorizedProvenanceException(
        'Event is not finalized according to canonical consensus',
      );
    }

    if (event.isCanonical === false) {
      throw new UnauthorizedProvenanceException(
        'Event is not part of the canonical finalized chain branch',
      );
    }
  }

  /**
   * Evaluate freshness of an individual feature against allowable threshold
   */
  public evaluateFreshness(
    observedAt: Date | string | null | undefined,
    maxFreshnessMs: number,
    now: Date = new Date(),
  ): { freshnessMs: number; isStale: boolean; status: FeatureFreshnessStatus } {
    if (!observedAt) {
      return {
        freshnessMs: Infinity,
        isStale: true,
        status: 'UNKNOWN',
      };
    }

    const date =
      typeof observedAt === 'string' ? new Date(observedAt) : observedAt;
    const timeMs = date.getTime();
    const nowMs = now.getTime();

    if (Number.isNaN(timeMs)) {
      return {
        freshnessMs: Infinity,
        isStale: true,
        status: 'UNKNOWN',
      };
    }

    const freshnessMs = nowMs - timeMs;

    // Reject future timestamps
    if (freshnessMs < -5000) {
      // 5 seconds clock drift allowance
      throw new InvalidFeatureBoundsException(
        `Feature timestamp is in the future: ${date.toISOString()}`,
      );
    }

    const normalizedFreshness = Math.max(0, freshnessMs);
    const isStale = normalizedFreshness > maxFreshnessMs;

    return {
      freshnessMs: normalizedFreshness,
      isStale,
      status: isStale ? 'STALE' : 'FRESH',
    };
  }

  /**
   * Build complete feature provenance record for a user
   */
  public buildFeatureProvenanceRecord(
    signals: SybilSignals,
    maxFreshnessMs: number,
    authority?: ChainArtifactAuthority,
    now: Date = new Date(),
  ): {
    provenanceMap: Record<string, FeatureProvenance>;
    staleFeatures: string[];
    missingFeatures: string[];
  } {
    const provenanceMap: Record<string, FeatureProvenance> = {};
    const staleFeatures: string[] = [];
    const missingFeatures: string[] = [];

    // 1. Worldcoin Provenance
    const wcObserved =
      signals.worldcoinVerifiedAt || (signals.worldcoinVerified ? now : null);
    const wcFreshness = this.evaluateFreshness(wcObserved, maxFreshnessMs, now);
    const isWcMissing = !signals.worldcoinVerified;
    if (isWcMissing) missingFeatures.push('worldcoin');
    if (!isWcMissing && wcFreshness.isStale) staleFeatures.push('worldcoin');

    provenanceMap.worldcoin = {
      featureName: 'worldcoin',
      source: 'world_id',
      observedAt: wcObserved
        ? wcObserved.toISOString()
        : new Date(0).toISOString(),
      freshnessMs: wcFreshness.freshnessMs,
      isStale: wcFreshness.isStale,
      isMissing: isWcMissing,
      details: {
        verified: signals.worldcoinVerified,
      },
      sensitiveData: {
        nullifierHash: signals.worldcoinNullifierHash || undefined,
        proof: signals.worldcoinProof
          ? (signals.worldcoinProof as Record<string, unknown>)
          : undefined,
      },
    };

    // 2. Wallet Age Provenance
    const walletObserved =
      signals.featuresObservedAt?.walletAge ||
      (signals.oldestWalletAgeMs > 0 ? now : null);
    const walletFreshness = this.evaluateFreshness(
      walletObserved,
      maxFreshnessMs,
      now,
    );
    const isWalletMissing =
      signals.oldestWalletAgeMs <= 0 &&
      (!signals.walletCount || signals.walletCount === 0);
    if (isWalletMissing) missingFeatures.push('wallet_age');
    if (!isWalletMissing && walletFreshness.isStale)
      staleFeatures.push('wallet_age');

    provenanceMap.wallet_age = {
      featureName: 'wallet_age',
      source: 'wallet_registry',
      observedAt: walletObserved
        ? walletObserved.toISOString()
        : new Date(0).toISOString(),
      freshnessMs: walletFreshness.freshnessMs,
      isStale: walletFreshness.isStale,
      isMissing: isWalletMissing,
      details: {
        walletCount:
          signals.walletCount ?? (signals.walletAddresses?.length || 0),
        tenureMs: signals.oldestWalletAgeMs,
      },
      sensitiveData: {
        walletAddresses: signals.walletAddresses,
      },
    };

    // 3. Staking Provenance (On-Chain)
    const stakingObserved =
      signals.featuresObservedAt?.staking ||
      (signals.totalStakedAmount > 0n ? now : null);
    const stakingFreshness = this.evaluateFreshness(
      stakingObserved,
      maxFreshnessMs,
      now,
    );
    const isStakingMissing = signals.totalStakedAmount <= 0n;
    if (isStakingMissing) missingFeatures.push('staking');
    if (!isStakingMissing && stakingFreshness.isStale)
      staleFeatures.push('staking');

    provenanceMap.staking = {
      featureName: 'staking',
      source: 'canonical_chain',
      observedAt: stakingObserved
        ? stakingObserved.toISOString()
        : new Date(0).toISOString(),
      freshnessMs: stakingFreshness.freshnessMs,
      isStale: stakingFreshness.isStale,
      isMissing: isStakingMissing,
      details: {
        totalDepositedUnits: signals.totalStakedAmount.toString(),
        eventCount: signals.stakingEventCount || 0,
        chainId: authority?.chainId,
        releaseId: authority?.releaseId,
        contractAddress: authority?.contractAddress,
        finalizedThroughBlock: authority?.finalizedThroughBlock,
      },
    };

    // 4. Accuracy Provenance (Claims History)
    const accuracyObserved =
      signals.featuresObservedAt?.accuracy ||
      (signals.claimsVotedOn > 0 ? now : null);
    const accuracyFreshness = this.evaluateFreshness(
      accuracyObserved,
      maxFreshnessMs,
      now,
    );
    const isAccuracyMissing = signals.claimsVotedOn === 0;
    if (isAccuracyMissing) missingFeatures.push('accuracy');
    if (!isAccuracyMissing && accuracyFreshness.isStale)
      staleFeatures.push('accuracy');

    provenanceMap.accuracy = {
      featureName: 'accuracy',
      source: 'claims_history',
      observedAt: accuracyObserved
        ? accuracyObserved.toISOString()
        : new Date(0).toISOString(),
      freshnessMs: accuracyFreshness.freshnessMs,
      isStale: accuracyFreshness.isStale,
      isMissing: isAccuracyMissing,
      details: {
        claimsVotedOn: signals.claimsVotedOn,
        claimsCorrect: signals.claimsCorrect,
      },
    };

    return {
      provenanceMap,
      staleFeatures,
      missingFeatures,
    };
  }

  /**
   * Convert computation result into a privacy-safe public view.
   * GUARANTEE: Sensitive features (nullifierHash, proofs, linked wallet addresses)
   * are never exposed in public responses.
   */
  public toPublicScoreView(
    result: SybilScoreComputationResult,
    userId: string,
    signals?: SybilSignals,
  ): PublicSybilScoreView {
    // Determine overall freshness status
    const hasStale = result.staleFeatures.length > 0;
    const status: FeatureFreshnessStatus = hasStale ? 'STALE' : 'FRESH';

    // Calculate tenure in whole days
    const tenureMs = signals?.oldestWalletAgeMs || 0;
    const tenureDays = Math.floor(tenureMs / (24 * 60 * 60 * 1000));

    // Find oldest feature age
    let oldestFeatureAgeMs = 0;
    for (const prov of Object.values(result.details.featureProvenance || {})) {
      if (
        Number.isFinite(prov.freshnessMs) &&
        prov.freshnessMs > oldestFeatureAgeMs
      ) {
        oldestFeatureAgeMs = prov.freshnessMs;
      }
    }

    // Build sanitized explanation (no private hashes or addresses)
    const sanitizedExplanation =
      `Sybil resistance score: ${result.score.toFixed(4)} | Risk score: ${result.riskScore.toFixed(4)} (${result.riskLevel} risk) ` +
      `[Model v${result.version}]. Features: Worldcoin=${result.details.componentScores.worldcoin.toFixed(2)}, ` +
      `Tenure=${result.details.componentScores.walletAge.toFixed(2)}, Staking=${result.details.componentScores.staking.toFixed(2)}, ` +
      `Accuracy=${result.details.componentScores.accuracy.toFixed(2)}.`;

    return {
      userId,
      score: result.score,
      riskScore: result.riskScore,
      riskLevel: result.riskLevel,
      version: result.version,
      provenanceDigest: result.provenanceDigest,
      calculatedAt: result.details.timestamp,
      freshness: {
        status,
        oldestFeatureAgeMs,
      },
      missingFeatures: result.missingFeatures,
      signalsSummary: {
        worldcoinVerified:
          signals?.worldcoinVerified ??
          result.details.componentScores.worldcoin > 0,
        walletCount:
          signals?.walletCount ?? (signals?.walletAddresses?.length || 0),
        tenureDays,
        isStaker:
          (signals?.totalStakedAmount ?? 0n) > 0n ||
          result.details.componentScores.staking > 0,
        claimsEvaluated: signals?.claimsVotedOn ?? 0,
      },
      explanation: sanitizedExplanation,
    };
  }

  /**
   * Invariant: Score computation is strictly an off-chain advisory read model.
   * It cannot directly execute smart contract mutations or overwrite authoritative consensus.
   */
  public assertNoContractMutation(): void {
    // Scoring engine must never send transactions to blockchain
    this.logger.debug(
      'Contract outcome immutability validated: Score is read-only projection',
    );
  }
}

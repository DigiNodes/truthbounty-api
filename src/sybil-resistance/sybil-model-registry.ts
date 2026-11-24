import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  InvalidFeatureBoundsException,
  SybilModelConfig,
  SybilModelVersion,
  SybilRiskLevel,
  SybilSignals,
} from './sybil-resistance.types';

@Injectable()
export class SybilModelRegistry {
  private readonly models = new Map<string, SybilModelConfig>();
  private readonly defaultVersion: string = '1.0.0';
  private readonly FIXED_POINT_SCALE = 1000000000n;

  constructor() {
    this.registerBuiltInModels();
  }

  private registerBuiltInModels(): void {
    // Model v1.0.0: Baseline composite scoring model (backward compatible)
    this.registerModel({
      version: '1.0.0',
      description:
        'Baseline weighted-composite Sybil resistance model with 90-day wallet age scaling',
      algorithm: 'weighted-composite-sigmoidal',
      weights: {
        worldcoin: 0.3,
        walletAge: 0.25,
        staking: 0.25,
        accuracy: 0.2,
      },
      thresholds: {
        walletAgeThresholdMs: 90 * 24 * 60 * 60 * 1000, // 90 days
        minStakingForFullScore: BigInt('1000000000000000000'), // 1 token (18 decimals)
        minClaimsForAccuracyScore: 5,
        maxFreshnessMs: 30 * 24 * 60 * 60 * 1000, // 30 days
      },
      riskParameters: {
        baselinePriorRisk: 0.85,
        missingFeatureRiskFloor: 0.2,
        riskBands: {
          lowMax: 0.25,
          mediumMax: 0.5,
          highMax: 0.75,
        },
      },
    });

    // Model v2.0.0: Enhanced strict multi-factor risk model
    this.registerModel({
      version: '2.0.0',
      description:
        'Strict multi-factor Sybil risk model with 180-day tenure and 14-day freshness constraints',
      algorithm: 'multi-factor-penalized-risk',
      weights: {
        worldcoin: 0.35,
        walletAge: 0.2,
        staking: 0.25,
        accuracy: 0.2,
      },
      thresholds: {
        walletAgeThresholdMs: 180 * 24 * 60 * 60 * 1000, // 180 days
        minStakingForFullScore: BigInt('2000000000000000000'), // 2 tokens
        minClaimsForAccuracyScore: 10,
        maxFreshnessMs: 14 * 24 * 60 * 60 * 1000, // 14 days
      },
      riskParameters: {
        baselinePriorRisk: 0.9,
        missingFeatureRiskFloor: 0.25,
        riskBands: {
          lowMax: 0.2,
          mediumMax: 0.45,
          highMax: 0.7,
        },
      },
    });
  }

  public registerModel(config: SybilModelConfig): void {
    const totalWeight =
      config.weights.worldcoin +
      config.weights.walletAge +
      config.weights.staking +
      config.weights.accuracy;
    if (Math.abs(totalWeight - 1.0) > 0.0001) {
      throw new Error(
        `Model ${config.version} weights must sum to 1.0 (got ${totalWeight})`,
      );
    }
    this.models.set(config.version, config);
  }

  public getModel(version?: SybilModelVersion): SybilModelConfig {
    const targetVersion = version || this.defaultVersion;
    const model = this.models.get(targetVersion);
    if (!model) {
      throw new Error(
        `Unsupported Sybil scoring model version: ${targetVersion}`,
      );
    }
    return model;
  }

  public getDefaultVersion(): string {
    return this.defaultVersion;
  }

  public listModels(): SybilModelConfig[] {
    return Array.from(this.models.values());
  }

  /**
   * Strict validation of input bounds — guards against NaN, Infinity, negative values, and anomalies
   */
  public validateInputBounds(signals: SybilSignals): void {
    if (typeof signals.worldcoinVerified !== 'boolean') {
      throw new InvalidFeatureBoundsException(
        'worldcoinVerified must be boolean',
      );
    }

    if (
      typeof signals.oldestWalletAgeMs !== 'number' ||
      !Number.isFinite(signals.oldestWalletAgeMs) ||
      Number.isNaN(signals.oldestWalletAgeMs)
    ) {
      throw new InvalidFeatureBoundsException(
        'oldestWalletAgeMs must be a finite number',
      );
    }

    if (signals.oldestWalletAgeMs < 0) {
      throw new InvalidFeatureBoundsException(
        `oldestWalletAgeMs cannot be negative: ${signals.oldestWalletAgeMs}`,
      );
    }

    // Unreasonable future date check (e.g. > 100 years in ms)
    const MAX_REASONABLE_AGE_MS = 100 * 365 * 24 * 60 * 60 * 1000;
    if (signals.oldestWalletAgeMs > MAX_REASONABLE_AGE_MS) {
      throw new InvalidFeatureBoundsException(
        `oldestWalletAgeMs exceeds maximum reasonable bounds: ${signals.oldestWalletAgeMs}`,
      );
    }

    if (typeof signals.totalStakedAmount !== 'bigint') {
      throw new InvalidFeatureBoundsException(
        'totalStakedAmount must be a bigint',
      );
    }

    if (signals.totalStakedAmount < 0n) {
      throw new InvalidFeatureBoundsException(
        `totalStakedAmount cannot be negative: ${signals.totalStakedAmount.toString()}`,
      );
    }

    if (
      typeof signals.claimsVotedOn !== 'number' ||
      !Number.isFinite(signals.claimsVotedOn) ||
      Number.isNaN(signals.claimsVotedOn)
    ) {
      throw new InvalidFeatureBoundsException(
        'claimsVotedOn must be a finite number',
      );
    }

    if (signals.claimsVotedOn < 0) {
      throw new InvalidFeatureBoundsException(
        `claimsVotedOn cannot be negative: ${signals.claimsVotedOn}`,
      );
    }

    if (
      typeof signals.claimsCorrect !== 'number' ||
      !Number.isFinite(signals.claimsCorrect) ||
      Number.isNaN(signals.claimsCorrect)
    ) {
      throw new InvalidFeatureBoundsException(
        'claimsCorrect must be a finite number',
      );
    }

    if (signals.claimsCorrect < 0) {
      throw new InvalidFeatureBoundsException(
        `claimsCorrect cannot be negative: ${signals.claimsCorrect}`,
      );
    }

    if (signals.claimsCorrect > signals.claimsVotedOn) {
      throw new InvalidFeatureBoundsException(
        `claimsCorrect (${signals.claimsCorrect}) cannot exceed claimsVotedOn (${signals.claimsVotedOn})`,
      );
    }
  }

  /**
   * Normalize input signals to 0.0 - 1.0 range according to version configuration
   */
  public normalizeSignals(
    signals: SybilSignals,
    config: SybilModelConfig,
  ): {
    normalized: {
      worldcoin: number;
      walletAge: number;
      staking: number;
      accuracy: number;
    };
    missingFeatures: string[];
  } {
    this.validateInputBounds(signals);
    const missingFeatures: string[] = [];

    // 1. Worldcoin: binary (1.0 or 0.0)
    let worldcoinScore = 0.0;
    if (signals.worldcoinVerified) {
      worldcoinScore = 1.0;
    } else {
      missingFeatures.push('worldcoin');
    }

    // 2. Wallet age: sigmoid scaling using fixed point math
    let walletAgeScore = 0.0;
    if (signals.oldestWalletAgeMs > 0) {
      walletAgeScore = this.calculateFixedPointSigmoid(
        signals.oldestWalletAgeMs,
        config.thresholds.walletAgeThresholdMs,
      );
    } else {
      missingFeatures.push('wallet_age');
    }

    // 3. Staking: logarithmic scaling with log1p
    let stakingScore = 0.0;
    if (signals.totalStakedAmount > 0n) {
      const stakedNum = Number(signals.totalStakedAmount);
      const minForFullNum = Number(config.thresholds.minStakingForFullScore);
      // Guard against division by zero
      const denominator = Math.log1p(minForFullNum > 0 ? minForFullNum : 1);
      stakingScore = Math.log1p(stakedNum) / denominator;
    } else {
      missingFeatures.push('staking');
    }

    // 4. Accuracy: ratio of correct claims if threshold met
    let accuracyScore = 0.0;
    if (signals.claimsVotedOn >= config.thresholds.minClaimsForAccuracyScore) {
      accuracyScore = signals.claimsCorrect / signals.claimsVotedOn;
    } else {
      missingFeatures.push('accuracy');
    }

    return {
      normalized: {
        worldcoin: this.clampScore(worldcoinScore),
        walletAge: this.clampScore(walletAgeScore),
        staking: this.clampScore(stakingScore),
        accuracy: this.clampScore(accuracyScore),
      },
      missingFeatures,
    };
  }

  /**
   * Fixed-point sigmoid calculation
   */
  public calculateFixedPointSigmoid(
    ageMs: number,
    thresholdMs: number,
  ): number {
    if (ageMs <= 0 || thresholdMs <= 0) return 0.0;
    const ageScore = BigInt(Math.floor(ageMs));
    const thresh = BigInt(Math.floor(thresholdMs));
    const x = (ageScore * this.FIXED_POINT_SCALE) / thresh;
    const scaled = (x * this.FIXED_POINT_SCALE) / (this.FIXED_POINT_SCALE + x);
    return Number(scaled) / Number(this.FIXED_POINT_SCALE);
  }

  /**
   * Calculate resistance score as weighted combination of normalized signals
   */
  public calculateCompositeResistanceScore(
    normalized: {
      worldcoin: number;
      walletAge: number;
      staking: number;
      accuracy: number;
    },
    config: SybilModelConfig,
  ): number {
    const raw =
      normalized.worldcoin * config.weights.worldcoin +
      normalized.walletAge * config.weights.walletAge +
      normalized.staking * config.weights.staking +
      normalized.accuracy * config.weights.accuracy;
    return this.clampScore(raw);
  }

  /**
   * Calculate Sybil risk score and risk classification.
   * INVARIANT: Missing inputs DO NOT silently become zero-risk!
   */
  public calculateRiskScore(
    resistanceScore: number,
    missingFeatures: string[],
    config: SybilModelConfig,
  ): { riskScore: number; riskLevel: SybilRiskLevel } {
    // Base risk is the inverse of resistance
    const baseRisk = 1.0 - resistanceScore;

    // Missing inputs floor: each missing feature enforces a minimum uncertainty floor.
    // An entity with 4 missing features receives maximum prior risk (1.0).
    const totalFeatureCount = 4.0;
    const missingRatio = missingFeatures.length / totalFeatureCount;
    const missingFloor =
      missingFeatures.length === 4
        ? 1.0
        : config.riskParameters.baselinePriorRisk * missingRatio;

    // The resulting risk is at least the missing feature risk floor
    const finalRisk = this.clampScore(Math.max(baseRisk, missingFloor));
    const riskScore = Number(finalRisk.toFixed(4));

    // Determine risk band
    let riskLevel: SybilRiskLevel;
    if (riskScore < config.riskParameters.riskBands.lowMax) {
      riskLevel = 'LOW';
    } else if (riskScore < config.riskParameters.riskBands.mediumMax) {
      riskLevel = 'MEDIUM';
    } else if (riskScore < config.riskParameters.riskBands.highMax) {
      riskLevel = 'HIGH';
    } else {
      riskLevel = 'CRITICAL';
    }

    return { riskScore, riskLevel };
  }

  public clampScore(value: number): number {
    if (!Number.isFinite(value) || Number.isNaN(value)) return 0.0;
    return Math.max(0.0, Math.min(1.0, value));
  }

  /**
   * Generate deterministic cryptographic SHA-256 provenance digest
   */
  public generateProvenanceDigest(payload: unknown): string {
    const canonicalString = this.canonicalStringify(payload);
    return createHash('sha256').update(canonicalString).digest('hex');
  }

  private canonicalStringify(obj: unknown): string {
    if (obj === null || typeof obj !== 'object') {
      return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
      return (
        '[' +
        obj.map((item: unknown) => this.canonicalStringify(item)).join(',') +
        ']'
      );
    }
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return (
      '{' +
      keys
        .map(
          (k) => JSON.stringify(k) + ':' + this.canonicalStringify(record[k]),
        )
        .join(',') +
      '}'
    );
  }
}

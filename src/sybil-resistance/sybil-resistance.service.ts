import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StakeEvent } from '../staking/entities/stake-event.entity';
import { StakingEventType } from '../staking/types/staking-event.type';
import { SybilModelRegistry } from './sybil-model-registry';
import { SybilProvenanceService } from './sybil-provenance.service';
import {
  CalculationDetails,
  ChainArtifactAuthority,
  InvalidFeatureBoundsException,
  MissingFeatureException,
  PublicSybilScoreView,
  RecomputeScoreOptions,
  StaleFeatureException,
  SybilAppealRecord,
  SybilAppealRequestDto,
  SybilScoreComputationResult,
  SybilSignals,
} from './sybil-resistance.types';

@Injectable()
export class SybilResistanceService {
  private readonly logger = new Logger(SybilResistanceService.name);

  // Model and Provenance sub-services
  private readonly modelRegistry: SybilModelRegistry;
  private readonly provenanceService: SybilProvenanceService;

  // Weighting constants for default backward-compatibility (sum to 1.0)
  private readonly WORLDCOIN_WEIGHT = 0.3;
  private readonly WALLET_AGE_WEIGHT = 0.25;
  private readonly STAKING_WEIGHT = 0.25;
  private readonly ACCURACY_WEIGHT = 0.2;

  // Scoring thresholds and normalization constants
  private readonly WALLET_AGE_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
  private readonly MIN_STAKING_FOR_FULL_SCORE = BigInt('1000000000000000000'); // 1 token (assuming 18 decimals)
  private readonly FIXED_POINT_SCALE = 1000000000n;
  private readonly MIN_CLAIMS_FOR_ACCURACY_SCORE: number;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    @InjectRepository(StakeEvent)
    private readonly stakeEventRepo: Repository<StakeEvent>,
    @Optional()
    modelRegistry?: SybilModelRegistry,
    @Optional()
    provenanceService?: SybilProvenanceService,
  ) {
    this.modelRegistry = modelRegistry || new SybilModelRegistry();
    this.provenanceService = provenanceService || new SybilProvenanceService();

    this.MIN_CLAIMS_FOR_ACCURACY_SCORE = this.configService.get<number>(
      'sybil.minClaimsForAccuracyScore',
      5,
    );
  }

  /**
   * Compute Sybil resistance score for a user
   * Combines identity, behavioral, and staking signals
   * Returns a normalized score (0-1) with full provenance details
   */
  async computeSybilScore(
    userId: string,
    options?: RecomputeScoreOptions,
  ): Promise<{
    score: number;
    details: CalculationDetails;
  }> {
    // 1. Fetch user and all signals
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { wallets: true },
    });

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    // 2. Resolve model configuration
    const modelVersion =
      options?.pinnedVersion || this.modelRegistry.getDefaultVersion();
    const modelConfig = this.modelRegistry.getModel(modelVersion);

    // 3. Validate authority if provided
    if (options?.authority) {
      this.provenanceService.validateChainAuthority(options.authority);
    }

    // 4. Gather all signals
    const signals = await this.gatherSignals(
      user,
      user.wallets,
      options?.authority,
    );

    // 5. Build feature provenance record
    const { provenanceMap, staleFeatures, missingFeatures } =
      this.provenanceService.buildFeatureProvenanceRecord(
        signals,
        modelConfig.thresholds.maxFreshnessMs,
        options?.authority,
      );

    // 6. Fail-closed guards
    if (options?.failClosedOnStale && staleFeatures.length > 0) {
      throw new StaleFeatureException(
        `Features exceeded max allowable age (${modelConfig.thresholds.maxFreshnessMs}ms): ${staleFeatures.join(', ')}`,
      );
    }

    if (options?.failClosedOnMissing && missingFeatures.length > 0) {
      throw new MissingFeatureException(
        `Required feature signals are missing: ${missingFeatures.join(', ')}`,
      );
    }

    // 7. Normalize signals according to model version (calls this.normalizeSignals so test spies work)
    const normalized = this.normalizeSignals(signals, modelConfig);

    // 8. Compute composite resistance score (calls this.weightedCombination and clampScore so test spies work)
    const compositeScore = this.clampScore(
      this.weightedCombination(normalized, modelConfig),
    );

    // 9. Compute risk score and risk classification
    // Invariant: Missing inputs DO NOT silently become zero-risk
    const { riskScore, riskLevel } = this.modelRegistry.calculateRiskScore(
      compositeScore,
      missingFeatures,
      modelConfig,
    );

    // 10. Generate cryptographic provenance digest
    const digestPayload = {
      userId,
      version: modelConfig.version,
      authority: options?.authority ?? null,
      componentScores: normalized,
      compositeScore: Number(compositeScore.toFixed(4)),
      riskScore,
      missingFeatures,
      staleFeatures,
    };
    const provenanceDigest =
      this.modelRegistry.generateProvenanceDigest(digestPayload);

    // 11. Create detailed calculation record
    const details = this.createCalculationDetails(
      normalized,
      modelConfig.version,
      riskScore,
      riskLevel,
      provenanceDigest,
      provenanceMap,
      missingFeatures,
      staleFeatures,
      modelConfig,
    );

    return {
      score: Number(compositeScore.toFixed(4)),
      details,
    };
  }

  /**
   * Recompute Sybil score with pinned version and fail-closed options
   */
  async recomputeScore(
    userId: string,
    options?: RecomputeScoreOptions,
  ): Promise<SybilScoreComputationResult> {
    const { score, details } = await this.computeSybilScore(userId, options);

    return {
      score,
      riskScore: details.riskScore,
      riskLevel: details.riskLevel,
      version: details.version,
      provenanceDigest: details.provenanceDigest,
      missingFeatures: details.missingFeatures,
      staleFeatures: details.staleFeatures,
      details,
    };
  }

  /**
   * Submit an appeal against a Sybil score calculation
   * Appeals are persisted to the database with idempotency protection
   */
  async submitAppeal(
    userId: string,
    appealRequest: SybilAppealRequestDto,
  ): Promise<SybilAppealRecord> {
    if (!appealRequest.reason || appealRequest.reason.trim().length < 5) {
      throw new InvalidFeatureBoundsException(
        'Appeal reason is required and must be at least 5 characters',
      );
    }

    if (appealRequest.reason.length > 2000) {
      throw new InvalidFeatureBoundsException(
        'Appeal reason cannot exceed 2000 characters',
      );
    }

    // Check user exists
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    // Generate idempotency key: hash of userId + reason prefix (first 100 chars) + time window (5 min buckets)
    // This prevents duplicate appeals for the same issue within a 5-minute window
    const timeWindow = Math.floor(Date.now() / (5 * 60 * 1000)); // 5-minute buckets
    const reasonPrefix = appealRequest.reason.trim().substring(0, 100);
    const idempotencyInput = `${userId}:${reasonPrefix}:${timeWindow}`;
    const idempotencyKey = createHash('sha256')
      .update(idempotencyInput)
      .digest('hex');

    // Check for existing appeal with same idempotency key
    const existingAppeal = await this.prisma.sybilAppeal.findUnique({
      where: { idempotencyKey },
    });

    if (existingAppeal) {
      this.logger.log(
        `Duplicate appeal detected for user ${userId}, returning existing appeal ${existingAppeal.appealId}`,
      );
      // Return existing appeal record in the expected format
      return {
        appealId: existingAppeal.appealId,
        userId: existingAppeal.userId,
        status: existingAppeal.status as any,
        reason: existingAppeal.reason,
        previousScore: existingAppeal.previousScore,
        previousRiskScore: existingAppeal.previousRiskScore,
        newScore: existingAppeal.newScore,
        newRiskScore: existingAppeal.newRiskScore,
        modelVersion: existingAppeal.modelVersion,
        recomputedAt: existingAppeal.recomputedAt.toISOString(),
        provenanceDigest: existingAppeal.provenanceDigest,
        additionalEvidenceSummary: existingAppeal.additionalEvidenceSummary,
      };
    }

    // Get latest score
    const previousRecord = await this.prisma.sybilScore.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    const previousScore = previousRecord ? previousRecord.compositeScore : 0.0;
    let previousRiskScore = 1.0;
    if (previousRecord?.calculationDetails) {
      try {
        const parsed = JSON.parse(previousRecord.calculationDetails) as Record<
          string,
          unknown
        >;
        if (typeof parsed.riskScore === 'number') {
          previousRiskScore = parsed.riskScore;
        }
      } catch {
        previousRiskScore = Number((1.0 - previousScore).toFixed(4));
      }
    }

    // Execute recomputation
    const recomputed = await this.recomputeScore(userId, {
      pinnedVersion: appealRequest.targetModelVersion,
      reason: appealRequest.reason,
    });

    // Record the newly recomputed score snapshot
    await this.recordSybilScore(userId, {
      pinnedVersion: recomputed.version,
    });

    const status = recomputed.score > previousScore ? 'RESOLVED' : 'UPHELD';
    const appealId = randomUUID();
    const recomputedAt = new Date();

    // Sanitize additional evidence to ensure no sensitive data is stored
    let evidenceSummary: string | undefined;
    if (appealRequest.additionalEvidence) {
      const sanitized = { ...appealRequest.additionalEvidence };
      // Remove any potential sensitive fields
      delete sanitized.nullifierHash;
      delete sanitized.proof;
      delete sanitized.privateKey;
      delete sanitized.seedPhrase;
      delete sanitized.walletAddresses;
      evidenceSummary = JSON.stringify(sanitized);
    }

    // Persist appeal to database
    const appeal = await this.prisma.sybilAppeal.create({
      data: {
        appealId,
        userId,
        status,
        reason: appealRequest.reason.trim(),
        previousScore,
        previousRiskScore,
        newScore: recomputed.score,
        newRiskScore: recomputed.riskScore,
        modelVersion: recomputed.version,
        recomputedAt,
        provenanceDigest: recomputed.provenanceDigest,
        additionalEvidenceSummary: evidenceSummary,
        idempotencyKey,
      },
    });

    this.logger.log(
      `Appeal ${appealId} for user ${userId}: status=${status}, prevScore=${previousScore}, newScore=${recomputed.score}`,
    );

    return {
      appealId: appeal.appealId,
      userId: appeal.userId,
      status: appeal.status as any,
      reason: appeal.reason,
      previousScore: appeal.previousScore,
      previousRiskScore: appeal.previousRiskScore,
      newScore: appeal.newScore,
      newRiskScore: appeal.newRiskScore,
      modelVersion: appeal.modelVersion,
      recomputedAt: appeal.recomputedAt.toISOString(),
      provenanceDigest: appeal.provenanceDigest,
      additionalEvidenceSummary: appeal.additionalEvidenceSummary,
    };
  }

  /**
   * Get all appeals history for a user
   * Returns appeals from the database, ordered by most recent first
   */
  async getAppeals(userId: string): Promise<SybilAppealRecord[]> {
    const appeals = await this.prisma.sybilAppeal.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return appeals.map((appeal) => ({
      appealId: appeal.appealId,
      userId: appeal.userId,
      status: appeal.status as any,
      reason: appeal.reason,
      previousScore: appeal.previousScore,
      previousRiskScore: appeal.previousRiskScore,
      newScore: appeal.newScore,
      newRiskScore: appeal.newRiskScore,
      modelVersion: appeal.modelVersion,
      recomputedAt: appeal.recomputedAt.toISOString(),
      provenanceDigest: appeal.provenanceDigest,
      additionalEvidenceSummary: appeal.additionalEvidenceSummary,
    }));
  }

  /**
   * Get a specific appeal by ID with authorization checks
   * Only the owner or authorized reviewers can access full appeal details
   */
  async getAppealById(
    appealId: string,
    requestingUserId: string,
    isReviewer: boolean = false,
  ): Promise<SybilAppealRecord> {
    const appeal = await this.prisma.sybilAppeal.findUnique({
      where: { appealId },
    });

    if (!appeal) {
      throw new NotFoundException(`Appeal ${appealId} not found`);
    }

    // Authorization: only owner or reviewer can access
    if (appeal.userId !== requestingUserId && !isReviewer) {
      throw new NotFoundException(`Appeal ${appealId} not found`);
    }

    return {
      appealId: appeal.appealId,
      userId: appeal.userId,
      status: appeal.status as any,
      reason: appeal.reason,
      previousScore: appeal.previousScore,
      previousRiskScore: appeal.previousRiskScore,
      newScore: appeal.newScore,
      newRiskScore: appeal.newRiskScore,
      modelVersion: appeal.modelVersion,
      recomputedAt: appeal.recomputedAt.toISOString(),
      provenanceDigest: appeal.provenanceDigest,
      additionalEvidenceSummary: appeal.additionalEvidenceSummary,
    };
  }

  /**
   * Review an appeal (admin/reviewer only)
   * Updates appeal status and records reviewer identity
   */
  async reviewAppeal(
    appealId: string,
    reviewerId: string,
    newStatus: 'UPHELD' | 'RESOLVED' | 'REJECTED',
    reviewNotes?: string,
  ): Promise<SybilAppealRecord> {
    const appeal = await this.prisma.sybilAppeal.findUnique({
      where: { appealId },
    });

    if (!appeal) {
      throw new NotFoundException(`Appeal ${appealId} not found`);
    }

    // Prevent status transitions from terminal states
    if (appeal.reviewerId && appeal.reviewedAt) {
      throw new ConflictException(
        `Appeal ${appealId} has already been reviewed and cannot be modified`,
      );
    }

    const updated = await this.prisma.sybilAppeal.update({
      where: { appealId },
      data: {
        status: newStatus,
        reviewerId,
        reviewedAt: new Date(),
        reviewNotes: reviewNotes || null,
      },
    });

    this.logger.log(
      `Appeal ${appealId} reviewed by ${reviewerId}: status=${newStatus}`,
    );

    return {
      appealId: updated.appealId,
      userId: updated.userId,
      status: updated.status as any,
      reason: updated.reason,
      previousScore: updated.previousScore,
      previousRiskScore: updated.previousRiskScore,
      newScore: updated.newScore,
      newRiskScore: updated.newRiskScore,
      modelVersion: updated.modelVersion,
      recomputedAt: updated.recomputedAt.toISOString(),
      provenanceDigest: updated.provenanceDigest,
      additionalEvidenceSummary: updated.additionalEvidenceSummary,
    };
  }

  /**
   * Get appeals with pagination and filtering (admin/reviewer only)
   */
  async getAppealsWithFilters(
    filters: {
      status?: string;
      userId?: string;
      modelVersion?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ appeals: SybilAppealRecord[]; total: number }> {
    const { status, userId, modelVersion, limit = 50, offset = 0 } = filters;

    const where: any = {};
    if (status) where.status = status;
    if (userId) where.userId = userId;
    if (modelVersion) where.modelVersion = modelVersion;

    const [appeals, total] = await Promise.all([
      this.prisma.sybilAppeal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.sybilAppeal.count({ where }),
    ]);

    return {
      appeals: appeals.map((appeal) => ({
        appealId: appeal.appealId,
        userId: appeal.userId,
        status: appeal.status as any,
        reason: appeal.reason,
        previousScore: appeal.previousScore,
        previousRiskScore: appeal.previousRiskScore,
        newScore: appeal.newScore,
        newRiskScore: appeal.newRiskScore,
        modelVersion: appeal.modelVersion,
        recomputedAt: appeal.recomputedAt.toISOString(),
        provenanceDigest: appeal.provenanceDigest,
        additionalEvidenceSummary: appeal.additionalEvidenceSummary,
      })),
      total,
    };
  }

  /**
   * Retrieve privacy-safe public view of Sybil score for a user
   */
  async getPublicSybilScore(userId: string): Promise<PublicSybilScoreView> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { wallets: true },
    });

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    const { score, details } = await this.computeSybilScore(userId);
    const signals = await this.gatherSignals(user, user.wallets);

    const computationResult: SybilScoreComputationResult = {
      score,
      riskScore: details.riskScore,
      riskLevel: details.riskLevel,
      version: details.version,
      provenanceDigest: details.provenanceDigest,
      missingFeatures: details.missingFeatures,
      staleFeatures: details.staleFeatures,
      details,
    };

    return this.provenanceService.toPublicScoreView(
      computationResult,
      userId,
      signals,
    );
  }

  /**
   * Gather all signals for a user
   */
  private async gatherSignals(
    user: { id: string; worldcoinVerified?: boolean; createdAt?: Date } | null,
    wallets: Array<{ address?: string; linkedAt: Date }>,
    authority?: ChainArtifactAuthority,
  ): Promise<SybilSignals> {
    const now = Date.now();
    let oldestWalletAgeMs = 0;
    const walletAddresses: string[] = [];

    if (wallets.length > 0) {
      for (const w of wallets) {
        if (w.address) walletAddresses.push(w.address);
      }

      const oldestWallet = wallets.reduce((oldest, w) =>
        new Date(w.linkedAt) < new Date(oldest.linkedAt) ? w : oldest,
      );

      const ageMs = now - new Date(oldestWallet.linkedAt).getTime();
      oldestWalletAgeMs = ageMs >= 0 ? ageMs : 0;
    }

    // Check for actual verification records (not just the user's boolean, to avoid stale data)
    let worldcoinVerified = false;
    let worldcoinVerifiedAt: Date | null = null;
    let worldcoinNullifierHash: string | null = null;
    let worldcoinProof: any = null;

    if (user) {
      const verification = await this.prisma.worldIdVerification.findFirst({
        where: { userId: user.id },
        orderBy: { verifiedAt: 'desc' },
      });

      if (verification) {
        worldcoinVerified = true;
        worldcoinVerifiedAt = verification.verifiedAt;
        worldcoinNullifierHash = verification.nullifierHash || null;
        worldcoinProof = verification.proof || null;
      } else if (user.worldcoinVerified) {
        worldcoinVerified = true;
        worldcoinVerifiedAt = user.createdAt || new Date();
      }
    }

    // Compute historical staking weight across all linked wallets.
    let totalHistoricalStake = BigInt(0);
    let stakingEventCount = 0;

    if (walletAddresses.length > 0) {
      const qb = this.stakeEventRepo
        .createQueryBuilder('se')
        .select('SUM(se.amount::numeric)', 'total')
        .where('se.walletAddress IN (:...addresses)', {
          addresses: walletAddresses,
        })
        .andWhere('se.type = :type', {
          type: StakingEventType.STAKE_DEPOSITED,
        });

      // Bind to finalized block checkpoint if authority is provided
      if (authority && Number.isSafeInteger(authority.finalizedThroughBlock)) {
        qb.andWhere('se.blockNumber <= :finalizedBlock', {
          finalizedBlock: authority.finalizedThroughBlock,
        });
      }

      const depositEvents = await qb.getRawOne<{ total: string | null }>();

      if (depositEvents?.total) {
        totalHistoricalStake = BigInt(Math.floor(Number(depositEvents.total)));
        stakingEventCount = 1;
      }
    }

    const claimsVotedOn = 0;
    const claimsCorrect = 0;

    return {
      worldcoinVerified,
      worldcoinVerifiedAt,
      worldcoinNullifierHash,
      worldcoinProof,
      oldestWalletAgeMs,
      walletCount: wallets.length,
      walletAddresses,
      totalStakedAmount: totalHistoricalStake,
      stakingEventCount,
      stakingFinalizedBlock: authority?.finalizedThroughBlock,
      claimsVotedOn,
      claimsCorrect,
    };
  }

  /**
   * Normalize signals to 0-1 range (legacy method retained for compatibility)
   */
  private normalizeSignals(
    signals: SybilSignals,
    config?: SybilModelConfig,
  ): {
    worldcoin: number;
    walletAge: number;
    staking: number;
    accuracy: number;
  } {
    const effectiveConfig = config || this.modelRegistry.getModel();
    const threshold =
      this.MIN_CLAIMS_FOR_ACCURACY_SCORE ??
      effectiveConfig.thresholds.minClaimsForAccuracyScore;
    const cfg: SybilModelConfig = {
      ...effectiveConfig,
      thresholds: {
        ...effectiveConfig.thresholds,
        minClaimsForAccuracyScore: threshold,
      },
    };
    return this.modelRegistry.normalizeSignals(signals, cfg).normalized;
  }

  /**
   * Weighted combination of normalized signals (legacy method retained for compatibility)
   */
  private weightedCombination(
    normalizedScores: {
      worldcoin: number;
      walletAge: number;
      staking: number;
      accuracy: number;
    },
    config?: SybilModelConfig,
  ): number {
    const cfg = config || this.modelRegistry.getModel();
    return (
      normalizedScores.worldcoin * cfg.weights.worldcoin +
      normalizedScores.walletAge * cfg.weights.walletAge +
      normalizedScores.staking * cfg.weights.staking +
      normalizedScores.accuracy * cfg.weights.accuracy
    );
  }

  /**
   * Clamp any score to the 0.0-1.0 range
   */
  private clampScore(value: number): number {
    return this.modelRegistry.clampScore(value);
  }

  /**
   * Create detailed calculation record for explainability and provenance
   */
  private createCalculationDetails(
    normalizedScores: {
      worldcoin: number;
      walletAge: number;
      staking: number;
      accuracy: number;
    },
    version: string = '1.0.0',
    riskScore: number = 0.0,
    riskLevel: any = 'LOW',
    provenanceDigest: string = '',
    featureProvenance: Record<string, any> = {},
    missingFeatures: string[] = [],
    staleFeatures: string[] = [],
    modelConfig?: SybilModelConfig,
  ): CalculationDetails {
    const config = modelConfig || this.modelRegistry.getModel(version);
    const composite = this.clampScore(
      this.modelRegistry.calculateCompositeResistanceScore(
        normalizedScores,
        config,
      ),
    );

    return {
      version,
      worldcoinWeight: config.weights.worldcoin,
      walletAgeWeight: config.weights.walletAge,
      stakingWeight: config.weights.staking,
      accuracyWeight: config.weights.accuracy,
      componentScores: {
        worldcoin: Number(normalizedScores.worldcoin.toFixed(4)),
        walletAge: Number(normalizedScores.walletAge.toFixed(4)),
        staking: Number(normalizedScores.staking.toFixed(4)),
        accuracy: Number(normalizedScores.accuracy.toFixed(4)),
      },
      timestamp: new Date().toISOString(),
      explanation: `Sybil resistance score calculated from 4 signals:
- Worldcoin verification (${normalizedScores.worldcoin.toFixed(2)}) - Identity proof
- Wallet age (${normalizedScores.walletAge.toFixed(2)}) - Account tenure
- Staking participation (${normalizedScores.staking.toFixed(2)}) - Economic commitment
- Claim accuracy (${normalizedScores.accuracy.toFixed(2)}) - Verification history
Final score: ${composite.toFixed(4)} (weighted average)`,
      riskScore,
      riskLevel,
      provenanceDigest,
      featureProvenance,
      missingFeatures,
      staleFeatures,
    };
  }

  /**
   * Store a Sybil score snapshot
   */
  async recordSybilScore(
    userId: string,
    options?: RecomputeScoreOptions,
  ): Promise<any> {
    const { score: compositeScore, details } = await this.computeSybilScore(
      userId,
      options,
    );

    // Persist SybilScore without the potentially large `explanation` text in JSON column
    const detailsCopy: any = { ...details };
    const explanationText = detailsCopy.explanation;
    delete detailsCopy.explanation;

    const scoreRecord = await this.prisma.sybilScore.create({
      data: {
        userId,
        worldcoinScore: details.componentScores.worldcoin,
        walletAgeScore: details.componentScores.walletAge,
        stakingScore: details.componentScores.staking,
        accuracyScore: details.componentScores.accuracy,
        compositeScore,
        calculationDetails: JSON.stringify(detailsCopy),
      },
    });

    // Store explanation separately to avoid huge JSON columns
    if (explanationText) {
      await this.prisma.sybilExplanation.create({
        data: {
          sybilScoreId: scoreRecord.id,
          explanation: explanationText,
        },
      });
    }

    return scoreRecord;
  }

  /**
   * Get the most recent Sybil score for a user
   */
  async getLatestSybilScore(userId: string): Promise<any> {
    const score = await this.prisma.sybilScore.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (!score) {
      return this.recordSybilScore(userId);
    }

    return score;
  }

  /**
   * Get the most recent Sybil scores for multiple users in a single query
   */
  async getLatestSybilScores(userIds: string[]): Promise<Map<string, any>> {
    if (userIds.length === 0) {
      return new Map();
    }

    const uniqueUserIds = [...new Set(userIds)];

    const scores = await this.prisma.sybilScore.findMany({
      where: { userId: { in: uniqueUserIds } },
      orderBy: { createdAt: 'desc' },
    });

    const latestByUser = new Map<string, any>();
    for (const score of scores) {
      if (!latestByUser.has(score.userId)) {
        latestByUser.set(score.userId, score);
      }
    }

    const missingUserIds = uniqueUserIds.filter((id) => !latestByUser.has(id));
    if (missingUserIds.length > 0) {
      const computedScores = await Promise.all(
        missingUserIds.map((userId) => this.recordSybilScore(userId)),
      );
      for (let i = 0; i < missingUserIds.length; i++) {
        latestByUser.set(missingUserIds[i], computedScores[i]);
      }
    }

    return latestByUser;
  }

  /**
   * Get all Sybil score history for a user
   */
  async getSybilScoreHistory(
    userId: string,
    limit: number = 10,
  ): Promise<any[]> {
    return this.prisma.sybilScore.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Batch recalculate Sybil scores for verification purposes
   */
  async recalculateAllScores(): Promise<
    Array<{
      userId: string;
      success: boolean;
      score?: number;
      error?: string;
    }>
  > {
    const users = await this.prisma.user.findMany();
    const results: Array<{
      userId: string;
      success: boolean;
      score?: number;
      error?: string;
    }> = [];

    for (const user of users) {
      try {
        const scoreRecord = await this.recordSybilScore(user.id);
        results.push({
          userId: user.id,
          success: true,
          score: scoreRecord.compositeScore,
        });
      } catch (error) {
        results.push({
          userId: user.id,
          success: false,
          error: error.message,
        });
      }
    }

    return results;
  }

  /**
   * Update Worldcoin verification status for a user
   */
  async setWorldcoinVerified(userId: string, verified: boolean): Promise<any> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { worldcoinVerified: verified },
    });

    return this.recordSybilScore(userId);
  }

  /**
   * Get Sybil score with metadata for verification/voting engines
   */
  async getSybilScoreForVoting(userId: string): Promise<{
    userId: string;
    score: number;
    isVerified: boolean;
    details: any;
  }> {
    const score = await this.getLatestSybilScore(userId);

    const details = score.calculationDetails
      ? JSON.parse(score.calculationDetails)
      : null;
    if (details && !details.explanation) {
      try {
        const expl = await this.prisma.sybilExplanation.findFirst({
          where: { sybilScoreId: score.id },
        });
        if (expl && expl.explanation) {
          details.explanation = expl.explanation;
        }
      } catch {
        // ignore missing explanation
      }
    }

    return {
      userId,
      score: score.compositeScore,
      isVerified: score.worldcoinScore > 0,
      details,
    };
  }

  /**
   * Delete SybilScore history records older than 1 year
   */
  async cleanupScoreHistory(): Promise<number> {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const result = await this.prisma.sybilScore.deleteMany({
      where: {
        createdAt: {
          lt: oneYearAgo,
        },
      },
    });

    return result.count;
  }

  /**
   * List available scoring models
   */
  getModelVersions(): any[] {
    return this.modelRegistry.listModels();
  }
}

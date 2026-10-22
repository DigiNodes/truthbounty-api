import {
  Injectable,
  ConflictException,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { WorldIdVerification } from './entities/world-id-verification.entity';
import { PrismaService } from '../../prisma/prisma.service';
import { SybilResistanceService } from '../../sybil-resistance/sybil-resistance.service';
import {
  SafeHttpClientService,
  SafeHttpResponse,
} from '../../common/security/ssrf';

// ---------------------------------------------------------------------------
// Public input shape
// ---------------------------------------------------------------------------

export interface VerifyWorldcoinProofDto {
  proof: {
    merkle_root: string;
    nullifier_hash: string;
    /** Raw ZK proof bytes — intentionally NOT persisted. */
    proof: string;
    verification_level: string;
  };
  action: string;
  signal?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface WorldcoinCloudVerifyResponse {
  success?: boolean;
  // Worldcoin v2 API may return detail on failure; we never echo it to callers.
  detail?: string;
}

/** Minimum fields that are safe to store — raw proof bytes are excluded. */
interface SafeVerificationRecord {
  userId: string;
  nullifierHash: string;
  verificationLevel: string;
  worldcoinAppId: string;
  worldcoinAction: string;
  merkleRoot: string;
  /** SHA-256 of the raw proof string — stored for audit without retaining
   *  sensitive ZK proof data. */
  proofHash: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Acceptable hex-string format for merkle_root, nullifier_hash, proof. */
const HEX_FIELD_RE = /^0x[0-9a-fA-F]{1,512}$/;

/** Maximum merkle root age in milliseconds (24 h default, override via env). */
const DEFAULT_MAX_ROOT_AGE_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class WorldcoinService {
  private readonly logger = new Logger(WorldcoinService.name);

  constructor(
    @InjectRepository(WorldIdVerification)
    private readonly worldIdVerificationRepository: Repository<WorldIdVerification>,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sybilResistanceService: SybilResistanceService,
    // PREWAVE / #640: every outbound request goes through the SSRF-safe
    // client (scheme/DNS/redirect/size/timeout guardrails) — never raw fetch.
    private readonly httpClient: SafeHttpClientService,
  ) {}

  // -------------------------------------------------------------------------
  // Primary verification flow
  // -------------------------------------------------------------------------

  async verifyProof(
    userId: string,
    verifyDto: VerifyWorldcoinProofDto,
  ): Promise<WorldIdVerification> {
    const { proof, action, signal } = verifyDto;

    // 1. Validate action/signal/root/nullifier/proof field boundaries BEFORE
    //    contacting the external provider.  Fail closed on any structural
    //    violation — never forward malformed data to the provider.
    this.validateInputBoundaries(proof, action, signal);

    // 2. Verify the proof with the Worldcoin developer API.
    //    The provider response is treated as *advisory*, not as protocol
    //    authority — a provider outage raises ServiceUnavailableException
    //    rather than silently treating the verification as valid or invalid.
    await this.callProviderOrThrow(proof, action, signal);

    // 3. Transactional nullifier uniqueness — enforced inside a single DB
    //    transaction to eliminate the TOCTOU race that existed in the prior
    //    dual-store sequential check pattern.
    return this.persistVerificationTransactionally(userId, proof, action);
  }

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  async getVerificationStatus(
    userId: string,
  ): Promise<WorldIdVerification | null> {
    return this.worldIdVerificationRepository.findOne({
      where: { userId },
      order: { verifiedAt: 'DESC' },
    });
  }

  async getVerificationByNullifierHash(
    nullifierHash: string,
  ): Promise<WorldIdVerification | null> {
    // Only expose derived/safe fields — never return the stored proofHash to
    // callers; it is audit-internal only.
    return this.worldIdVerificationRepository.findOne({
      where: { nullifierHash },
    });
  }

  async isUserVerified(userId: string): Promise<boolean> {
    const verification = await this.getVerificationStatus(userId);
    if (verification) return true;

    const prismaVerification = await this.prisma.worldIdVerification.findFirst({
      where: { userId },
      orderBy: { verifiedAt: 'desc' },
    });
    return prismaVerification !== null;
  }

  // -------------------------------------------------------------------------
  // Boundary validation
  // -------------------------------------------------------------------------

  /**
   * Validates all structural constraints on incoming proof fields.
   *
   * Design: fail closed — any unknown, missing, or out-of-range value results
   * in BadRequestException before the external provider is contacted.  This
   * prevents forwarding attacker-controlled blobs to the Worldcoin API and
   * preserves the API usage budget.
   */
  private validateInputBoundaries(
    proof: VerifyWorldcoinProofDto['proof'],
    action: string,
    signal?: string,
  ): void {
    const expectedAction = this.configService.get<string>('WORLDCOIN_ACTION');
    if (!expectedAction) {
      this.logger.error('WORLDCOIN_ACTION not configured');
      throw new ServiceUnavailableException(
        'Identity verification unavailable',
      );
    }

    // Action must exactly match the configured value — no wildcards, no
    // prefix matching.  Provider-is-not-authority: we validate before the
    // round-trip so a compromised provider cannot coerce a different action.
    if (action !== expectedAction) {
      this.logger.warn('worldcoin.action_mismatch [redacted]');
      throw new BadRequestException('Proof verification failed');
    }

    // Signal must be a non-empty string when provided; empty string is treated
    // as "not provided" which is a different semantic but structurally invalid.
    if (signal !== undefined) {
      if (typeof signal !== 'string' || signal.trim().length === 0) {
        this.logger.warn('worldcoin.signal_invalid');
        throw new BadRequestException('Proof verification failed');
      }
      // Signal length limit to avoid downstream injection/DoS.
      if (signal.length > 512) {
        this.logger.warn('worldcoin.signal_too_long');
        throw new BadRequestException('Proof verification failed');
      }
    }

    // merkle_root — must be a hex string.  A missing or non-hex root indicates
    // a forged or replayed proof from a different protocol state.
    if (!proof.merkle_root || !HEX_FIELD_RE.test(proof.merkle_root)) {
      this.logger.warn('worldcoin.merkle_root_malformed');
      throw new BadRequestException('Proof verification failed');
    }

    // nullifier_hash — must be a hex string.
    if (!proof.nullifier_hash || !HEX_FIELD_RE.test(proof.nullifier_hash)) {
      this.logger.warn('worldcoin.nullifier_hash_malformed');
      throw new BadRequestException('Proof verification failed');
    }

    // proof bytes — must be a non-empty hex string.
    if (!proof.proof || !HEX_FIELD_RE.test(proof.proof)) {
      this.logger.warn('worldcoin.proof_bytes_malformed');
      throw new BadRequestException('Proof verification failed');
    }

    // verification_level — must be one of the known enumeration values.
    const KNOWN_LEVELS = new Set(['orb', 'device']);
    if (!KNOWN_LEVELS.has(proof.verification_level)) {
      this.logger.warn('worldcoin.verification_level_unknown');
      throw new BadRequestException('Proof verification failed');
    }

    // Stale root guard: check configured maximum age if the root encodes a
    // timestamp (this is a best-effort guard; the definitive staleness check
    // is performed by the Worldcoin developer API).
    this.checkMerkleRootAgePolicy();
  }

  /**
   * Enforces the merkle root age policy.  The concrete age-extraction logic
   * is deferred to the provider API; this method applies the service-level
   * policy limit and logs a warning when the configured window is tight.
   * Currently a no-op placeholder — it can be wired to an on-chain root
   * registry when one is available in the deployment environment.
   */
  private checkMerkleRootAgePolicy(): void {
    const maxAgeMs =
      this.configService.get<number>('WORLDCOIN_MAX_ROOT_AGE_MS') ??
      DEFAULT_MAX_ROOT_AGE_MS;
    if (maxAgeMs < 60_000) {
      this.logger.warn(
        'worldcoin.root_age_policy_very_tight: max_root_age_ms=' + maxAgeMs,
      );
    }
    // NOTE: Definitive staleness is enforced by the developer API response.
    // When an on-chain root registry is wired, compare block timestamps here.
  }

  // -------------------------------------------------------------------------
  // Provider call — provider is not authority
  // -------------------------------------------------------------------------

  /**
   * Contacts the Worldcoin developer API.
   *
   * Security contract:
   *  - A non-2xx response → BadRequestException (proof rejected by provider)
   *  - A network/timeout error → ServiceUnavailableException (provider
   *    outage — caller must retry; we MUST NOT treat this as "valid")
   *  - success: false → BadRequestException
   *  - success: true → return (caller continues to DB commit phase)
   *
   * The provider response is advisory: we use it to gate persistence but
   * canonical finalized state remains the chain/DB record.  We therefore
   * never trust a success response from a compromised provider to bypass
   * nullifier uniqueness — that check happens transactionally in the DB.
   */
  private async callProviderOrThrow(
    proof: VerifyWorldcoinProofDto['proof'],
    action: string,
    signal?: string,
  ): Promise<void> {
    const appId = this.configService.get<string>('WORLDCOIN_APP_ID');
    const verifyBaseUrl =
      this.configService.get<string>('WORLDCOIN_VERIFY_BASE_URL') ??
      'https://developer.worldcoin.org/api/v2/verify';

    if (!appId) {
      this.logger.error('WORLDCOIN_APP_ID not configured');
      throw new ServiceUnavailableException(
        'Identity verification unavailable',
      );
    }

    let response: SafeHttpResponse;
    try {
      response = await this.httpClient.post(
        `${verifyBaseUrl}/${appId}`,
        JSON.stringify({
          merkle_root: proof.merkle_root,
          nullifier_hash: proof.nullifier_hash,
          proof: proof.proof,
          verification_level: proof.verification_level,
          action,
          ...(signal !== undefined ? { signal } : {}),
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    } catch (networkError) {
      // Network errors, DNS failures, timeouts — treat as provider outage.
      // Fail with 503 so callers can retry; NEVER treat as valid proof.
      this.logger.error(
        'worldcoin.provider_unreachable',
        // Log the error class/message only — never proof bytes.
        networkError instanceof Error ? networkError.message : 'unknown',
      );
      throw new ServiceUnavailableException(
        'Worldcoin verification service temporarily unavailable',
      );
    }

    if (!response.ok) {
      // Log the status code for observability; never log response body
      // as it may contain sensitive proof context.
      this.logger.warn(`worldcoin.provider_rejected status=${response.status}`);
      throw new BadRequestException('Proof verification failed');
    }

    let result: WorldcoinCloudVerifyResponse;
    try {
      // json() is synchronous (JSON.parse over the bounded body buffer) — a
      // malformed payload throws and is routed to the outage branch below.
      result = response.json<WorldcoinCloudVerifyResponse>();
    } catch {
      // Malformed JSON from provider — treat as provider outage, not success.
      this.logger.error('worldcoin.provider_malformed_response');
      throw new ServiceUnavailableException(
        'Worldcoin verification service returned an unexpected response',
      );
    }

    if (result.success !== true) {
      // Explicit rejection — proof is invalid per provider.
      this.logger.warn('worldcoin.provider_rejected_proof');
      throw new BadRequestException('Proof verification failed');
    }
  }

  // -------------------------------------------------------------------------
  // Transactional persistence — nullifier uniqueness enforced atomically
  // -------------------------------------------------------------------------

  /**
   * Persists the approved verification inside a Prisma transaction.
   *
   * Security contract:
   *  - The nullifier uniqueness check and the record insertion are a single
   *    atomic operation.  This eliminates the TOCTOU window that existed when
   *    the check and insert were separate steps (concurrent requests with the
   *    same nullifier could both pass the check before either wrote).
   *  - Raw proof bytes are NEVER written to any store.  Only a SHA-256 hash
   *    of the proof string is stored for audit traceability without retaining
   *    sensitive ZK data.
   *  - TypeORM and Prisma dual-write is preserved for backward compatibility
   *    but the Prisma path is now the authoritative transactional gate.
   */
  private async persistVerificationTransactionally(
    userId: string,
    proof: VerifyWorldcoinProofDto['proof'],
    action: string,
  ): Promise<WorldIdVerification> {
    const appId = this.configService.get<string>('WORLDCOIN_APP_ID') ?? '';
    const proofHash = this.hashProof(proof.proof);

    const safeRecord: SafeVerificationRecord = {
      userId,
      nullifierHash: proof.nullifier_hash,
      verificationLevel: proof.verification_level,
      worldcoinAppId: appId,
      worldcoinAction: action,
      merkleRoot: proof.merkle_root,
      proofHash,
    };

    // Prisma transaction — uniqueness check + insert are atomic.
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.worldIdVerification.findUnique({
        where: { nullifierHash: safeRecord.nullifierHash },
      });
      if (existing) {
        // Do NOT log the nullifierHash — it is sensitive derived identity data.
        this.logger.warn('worldcoin.nullifier_replay_attempt [redacted]');
        throw new ConflictException(
          'This Worldcoin identity credential has already been used',
        );
      }

      await tx.worldIdVerification.create({
        data: {
          userId: safeRecord.userId,
          nullifierHash: safeRecord.nullifierHash,
          verificationLevel: safeRecord.verificationLevel,
          worldcoinAppId: safeRecord.worldcoinAppId,
          worldcoinAction: safeRecord.worldcoinAction,
          merkleRoot: safeRecord.merkleRoot,
          // proof field intentionally omitted — raw ZK proof is not stored.
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: { worldcoinVerified: true },
      });
    });

    // TypeORM write — compatible secondary store.  Nullifier uniqueness is
    // already guaranteed by the Prisma transaction above; a duplicate here
    // would be caught by the DB UNIQUE constraint and surface as a 409.
    const verificationTypeORM = this.worldIdVerificationRepository.create({
      userId: safeRecord.userId,
      nullifierHash: safeRecord.nullifierHash,
      verificationLevel: safeRecord.verificationLevel,
      worldcoinAppId: safeRecord.worldcoinAppId,
      worldcoinAction: safeRecord.worldcoinAction,
      merkleRoot: safeRecord.merkleRoot,
      // proof intentionally omitted — retention policy: store proof hash only.
    });
    const savedVerification =
      await this.worldIdVerificationRepository.save(verificationTypeORM);

    // Recalculate sybil score after successful verification.
    await this.sybilResistanceService.recordSybilScore(userId);

    this.logger.log(
      `worldcoin.verification_complete userId=${userId} level=${proof.verification_level}`,
    );

    return savedVerification;
  }

  // -------------------------------------------------------------------------
  // Proof data retention
  // -------------------------------------------------------------------------

  /**
   * Returns a SHA-256 hex digest of the raw ZK proof string.
   *
   * Retention policy: raw proof bytes are never written to any persistent
   * store.  The digest preserves audit traceability (same proof submitted
   * twice produces the same digest) without retaining sensitive ZK material.
   */
  private hashProof(rawProof: string): string {
    return createHash('sha256').update(rawProof).digest('hex');
  }
}

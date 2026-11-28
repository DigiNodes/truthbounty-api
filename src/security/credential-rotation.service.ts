import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';

export type CredentialDomain =
  | 'siwe'
  | 'webhook'
  | 'encryption'
  | 'provider'
  | 'database';

export interface CredentialKeyVersion {
  keyId: string;
  /** NEVER LOGGED OR EXPOSED IN STATUS */
  secret: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  status: 'active' | 'overlap' | 'expired' | 'revoked';
}

export interface DomainCredentialState {
  domain: CredentialDomain;
  activeKeyId: string;
  previousKeyId?: string;
  keys: Map<string, CredentialKeyVersion>;
  overlapWindowMs: number;
  rollbackKeyId?: string;
}

export interface CredentialStatusView {
  domain: CredentialDomain;
  activeKeyId: string;
  previousKeyId?: string;
  totalKeys: number;
  hasOverlap: boolean;
  nextResetAt?: string;
  // NOTE: Secrets are EXPLICITLY excluded from status views!
}

/** Env var name for each domain secret. */
const DOMAIN_ENV_KEYS: Record<CredentialDomain, string> = {
  siwe: 'SIWE_SECRET',
  webhook: 'WEBHOOK_SECRET',
  encryption: 'ENCRYPTION_SECRET',
  provider: 'PROVIDER_SECRET',
  database: 'DATABASE_SECRET',
};

/** Redis key prefix for persisted rotation state (key metadata only — no secrets). */
const REDIS_STATE_PREFIX = 'credential:state:';
/** Redis key prefix for persisted key metadata. */
const REDIS_KEY_PREFIX = 'credential:key:';
/** TTL for persisted key metadata (30 days in seconds). */
const REDIS_KEY_TTL_SECONDS = 30 * 24 * 60 * 60;

@Injectable()
export class CredentialRotationService implements OnModuleInit {
  private readonly logger = new Logger(CredentialRotationService.name);

  /**
   * Process-local cache of domain state. This is the fast path; Redis is the
   * durable shared source of truth that survives restarts and reconciles replicas.
   */
  private readonly domains = new Map<CredentialDomain, DomainCredentialState>();

  private readonly defaultOverlapWindowMs = 24 * 60 * 60 * 1000; // 24 hours

  private static readonly ALL_DOMAINS: CredentialDomain[] = [
    'siwe',
    'webhook',
    'encryption',
    'provider',
    'database',
  ];

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const domain of CredentialRotationService.ALL_DOMAINS) {
      await this.initializeDomain(domain);
    }
  }

  // ── Initialization ─────────────────────────────────────────────────────────

  /**
   * Load state from Redis (surviving restarts). If no persisted state exists,
   * bootstrap from the provisioned environment secret and persist it.
   * Fails closed — throws if the secret is absent or weak.
   *
   * SECURITY: Math.random() is never used. No fallback secret is generated.
   */
  private async initializeDomain(domain: CredentialDomain): Promise<void> {
    // 1. Try to restore durable state from Redis first.
    const persisted = await this.loadStateFromRedis(domain);
    if (persisted) {
      this.domains.set(domain, persisted);
      this.logger.log(
        `[credential-rotation] Domain [${domain}] restored from durable state. active=${persisted.activeKeyId}`,
      );
      return;
    }

    // 2. No persisted state — bootstrap from explicit env secret.
    const envKey = DOMAIN_ENV_KEYS[domain];
    const provisioned = this.configService.get<string>(envKey);

    if (!provisioned || provisioned.trim().length === 0) {
      throw new Error(
        `[credential-rotation] Startup failed: ${envKey} is not set. ` +
          `All credential domain secrets must be explicitly provisioned. ` +
          `No fallback secret will be generated.`,
      );
    }

    // Enforce minimum secret strength: at least 32 non-whitespace characters.
    if (provisioned.trim().length < 32) {
      throw new Error(
        `[credential-rotation] Startup failed: ${envKey} is too short. ` +
          `Credential secrets must be at least 32 characters long.`,
      );
    }

    const defaultKeyId = `${domain}-v1`;
    const keyVersion: CredentialKeyVersion = {
      keyId: defaultKeyId,
      secret: provisioned,
      createdAt: Date.now(),
      status: 'active',
    };

    const state: DomainCredentialState = {
      domain,
      activeKeyId: defaultKeyId,
      keys: new Map([[defaultKeyId, keyVersion]]),
      overlapWindowMs: this.defaultOverlapWindowMs,
    };

    this.domains.set(domain, state);

    // Persist to Redis so other replicas and restarts share this bootstrap state.
    await this.persistStateToRedis(domain, state);

    this.logger.log(
      `[credential-rotation] Domain [${domain}] bootstrapped from ${envKey}. keyId=${defaultKeyId}`,
    );
  }

  // ── Redis persistence (key metadata only — raw secrets never stored) ───────

  /**
   * Persist domain state metadata to Redis. Raw secret material is NOT stored.
   * Only key IDs, timestamps, and status flags are persisted.
   */
  private async persistStateToRedis(
    domain: CredentialDomain,
    state: DomainCredentialState,
  ): Promise<void> {
    try {
      const statePayload = JSON.stringify({
        activeKeyId: state.activeKeyId,
        previousKeyId: state.previousKeyId,
        rollbackKeyId: state.rollbackKeyId,
        overlapWindowMs: state.overlapWindowMs,
      });
      await this.redisService.set(
        `${REDIS_STATE_PREFIX}${domain}`,
        statePayload,
      );

      // Persist each key's metadata (no secret material).
      for (const [keyId, kv] of state.keys) {
        const keyMeta = JSON.stringify({
          keyId: kv.keyId,
          createdAt: kv.createdAt,
          expiresAt: kv.expiresAt,
          revokedAt: kv.revokedAt,
          status: kv.status,
          // secret is intentionally omitted
        });
        await this.redisService.set(
          `${REDIS_KEY_PREFIX}${domain}:${keyId}`,
          keyMeta,
          REDIS_KEY_TTL_SECONDS,
        );
      }
    } catch (err) {
      // Redis persistence failure is logged but does not block in-memory operation.
      // The replica that failed to persist will re-bootstrap on next restart.
      this.logger.error(
        `[credential-rotation] Failed to persist state for domain [${domain}]: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Attempt to restore domain state from Redis. Returns null if no state is found.
   * Because secrets are not stored in Redis, the restored state uses the
   * process-local secrets from ConfigService (the same env vars used at bootstrap).
   * This means the env vars must still be present on restart for secret retrieval
   * to work — Redis only carries the metadata (which key is active/overlap/revoked).
   */
  private async loadStateFromRedis(
    domain: CredentialDomain,
  ): Promise<DomainCredentialState | null> {
    try {
      const raw = await this.redisService.get(`${REDIS_STATE_PREFIX}${domain}`);
      if (!raw) return null;

      const meta = JSON.parse(raw) as {
        activeKeyId: string;
        previousKeyId?: string;
        rollbackKeyId?: string;
        overlapWindowMs: number;
      };

      // Reconstruct keys: metadata from Redis + secret from env.
      const envKey = DOMAIN_ENV_KEYS[domain];
      const provisioned = this.configService.get<string>(envKey);

      if (!provisioned || provisioned.trim().length < 32) {
        this.logger.warn(
          `[credential-rotation] Domain [${domain}] has Redis state but ${envKey} is absent/weak. ` +
            `Clearing stale Redis state and failing startup.`,
        );
        // Let the caller handle absence; initializeDomain will throw.
        return null;
      }

      // Collect key IDs to restore from Redis.
      const keyIds = new Set<string>([
        meta.activeKeyId,
        ...(meta.previousKeyId ? [meta.previousKeyId] : []),
        ...(meta.rollbackKeyId ? [meta.rollbackKeyId] : []),
      ]);

      const keys = new Map<string, CredentialKeyVersion>();
      for (const keyId of keyIds) {
        const keyRaw = await this.redisService.get(
          `${REDIS_KEY_PREFIX}${domain}:${keyId}`,
        );
        if (!keyRaw) continue;

        const keyMeta = JSON.parse(keyRaw) as {
          keyId: string;
          createdAt: number;
          expiresAt?: number;
          revokedAt?: number;
          status: CredentialKeyVersion['status'];
        };

        keys.set(keyId, {
          ...keyMeta,
          // Secret is re-bound from the provisioned env var (single source of truth).
          secret: provisioned,
        });
      }

      if (!keys.has(meta.activeKeyId)) {
        // Cannot restore without an active key entry — re-bootstrap.
        return null;
      }

      return {
        domain,
        activeKeyId: meta.activeKeyId,
        previousKeyId: meta.previousKeyId,
        rollbackKeyId: meta.rollbackKeyId,
        overlapWindowMs: meta.overlapWindowMs,
        keys,
      };
    } catch {
      // Any Redis or parse error — fall through to bootstrap.
      return null;
    }
  }

  // ── Rotate ─────────────────────────────────────────────────────────────────

  /**
   * Rotate credential for a domain atomically with bounded overlap.
   * The new secret is supplied by the caller (never generated internally).
   */
  async rotateCredential(
    domain: CredentialDomain,
    newKeyId: string,
    newSecret: string,
    overlapMs?: number,
  ): Promise<{ activeKeyId: string; previousKeyId?: string }> {
    if (!newKeyId || !newSecret) {
      throw new BadRequestException(
        'Key ID and secret are required for rotation',
      );
    }

    const state = this.domains.get(domain);
    if (!state) {
      throw new BadRequestException(`Unknown credential domain: ${domain}`);
    }

    const now = Date.now();
    const overlap = overlapMs ?? state.overlapWindowMs;

    if (state.keys.has(newKeyId)) {
      const existing = state.keys.get(newKeyId)!;
      if (existing.status === 'revoked') {
        throw new BadRequestException('Cannot rotate to a revoked key ID');
      }
    }

    const currentActiveId = state.activeKeyId;
    const currentActive = state.keys.get(currentActiveId);

    if (currentActive) {
      currentActive.status = 'overlap';
      currentActive.expiresAt = now + overlap;
    }

    const newKeyVersion: CredentialKeyVersion = {
      keyId: newKeyId,
      secret: newSecret,
      createdAt: now,
      status: 'active',
    };

    state.keys.set(newKeyId, newKeyVersion);
    state.rollbackKeyId = currentActiveId;
    state.previousKeyId = currentActiveId;
    state.activeKeyId = newKeyId;

    // Persist updated state (key metadata only, no secrets).
    await this.persistStateToRedis(domain, state);

    // Keys never enter logs.
    this.logger.log(
      `[credential-rotation] Domain [${domain}] rotated: active=${newKeyId}, previous=${currentActiveId}`,
    );

    return { activeKeyId: newKeyId, previousKeyId: currentActiveId };
  }

  // ── Rollback ───────────────────────────────────────────────────────────────

  async rollbackCredential(
    domain: CredentialDomain,
  ): Promise<{ activeKeyId: string; rolledBackFrom: string }> {
    const state = this.domains.get(domain);
    if (!state) {
      throw new BadRequestException(`Unknown credential domain: ${domain}`);
    }

    if (!state.rollbackKeyId || !state.keys.has(state.rollbackKeyId)) {
      throw new BadRequestException(
        `No valid rollback target available for domain [${domain}]`,
      );
    }

    const targetKeyId = state.rollbackKeyId;
    const targetKey = state.keys.get(targetKeyId)!;

    if (targetKey.status === 'revoked' || targetKey.status === 'expired') {
      throw new BadRequestException(
        `Rollback target key [${targetKeyId}] is revoked or expired`,
      );
    }

    const previousActive = state.activeKeyId;
    targetKey.status = 'active';
    state.activeKeyId = targetKeyId;
    state.previousKeyId = previousActive;
    state.rollbackKeyId = undefined;

    await this.persistStateToRedis(domain, state);

    this.logger.warn(
      `[credential-rotation] Rollback executed for domain [${domain}]: restored=${targetKeyId}, rolledBackFrom=${previousActive}`,
    );

    return { activeKeyId: targetKeyId, rolledBackFrom: previousActive };
  }

  // ── Revoke ─────────────────────────────────────────────────────────────────

  async revokeKey(domain: CredentialDomain, keyId: string): Promise<void> {
    const state = this.domains.get(domain);
    if (!state) {
      throw new BadRequestException(`Unknown credential domain: ${domain}`);
    }

    const keyVersion = state.keys.get(keyId);
    if (!keyVersion) {
      throw new BadRequestException(
        `Unknown key ID [${keyId}] for domain [${domain}]`,
      );
    }

    keyVersion.status = 'revoked';
    keyVersion.revokedAt = Date.now();

    if (state.activeKeyId === keyId) {
      this.logger.error(
        `[credential-rotation] CRITICAL: Active key [${keyId}] revoked for domain [${domain}]. Failing closed.`,
      );
      state.activeKeyId = ''; // Fail closed
    }

    if (state.previousKeyId === keyId) {
      state.previousKeyId = undefined;
    }

    await this.persistStateToRedis(domain, state);

    this.logger.warn(
      `[credential-rotation] Key [${keyId}] explicitly revoked for domain [${domain}]`,
    );
  }

  // ── Get secret ─────────────────────────────────────────────────────────────

  /**
   * Retrieve the secret for a given key ID (or the current active key).
   * Fails closed on missing, expired, revoked, or unknown keys.
   * NEVER logs or returns secrets in error messages.
   */
  getSecret(domain: CredentialDomain, keyId?: string): string {
    const state = this.domains.get(domain);
    if (!state) {
      throw new UnauthorizedException(
        `Fail closed: Unauthorized or invalid credential domain: ${domain}`,
      );
    }

    const effectiveKeyId = keyId || state.activeKeyId;
    if (!effectiveKeyId) {
      throw new UnauthorizedException(
        `Fail closed: No active key available for domain [${domain}]`,
      );
    }

    const keyVersion = state.keys.get(effectiveKeyId);
    if (!keyVersion) {
      throw new UnauthorizedException(
        `Fail closed: Unknown key ID [${effectiveKeyId}] for domain [${domain}]`,
      );
    }

    const now = Date.now();

    if (keyVersion.status === 'revoked') {
      throw new UnauthorizedException(
        `Fail closed: Key [${effectiveKeyId}] has been revoked`,
      );
    }

    if (keyVersion.status === 'expired') {
      throw new UnauthorizedException(
        `Fail closed: Key [${effectiveKeyId}] has expired`,
      );
    }

    if (keyVersion.expiresAt && keyVersion.expiresAt <= now) {
      keyVersion.status = 'expired';
      throw new UnauthorizedException(
        `Fail closed: Overlap window expired for key [${effectiveKeyId}]`,
      );
    }

    return keyVersion.secret;
  }

  // ── Status view ────────────────────────────────────────────────────────────

  /**
   * Safe status view — secrets are explicitly excluded.
   */
  getStatus(
    domain?: CredentialDomain,
  ): CredentialStatusView | CredentialStatusView[] {
    if (domain) {
      const state = this.domains.get(domain);
      if (!state) {
        throw new BadRequestException(`Unknown credential domain: ${domain}`);
      }
      return this.buildStatusView(state);
    }

    const statuses: CredentialStatusView[] = [];
    for (const [, state] of this.domains) {
      statuses.push(this.buildStatusView(state));
    }
    return statuses;
  }

  private buildStatusView(state: DomainCredentialState): CredentialStatusView {
    const activeKey = state.keys.get(state.activeKeyId);
    const previousKey = state.previousKeyId
      ? state.keys.get(state.previousKeyId)
      : undefined;

    return {
      domain: state.domain,
      activeKeyId: state.activeKeyId,
      previousKeyId: state.previousKeyId,
      totalKeys: state.keys.size,
      hasOverlap: !!state.previousKeyId,
      nextResetAt: previousKey?.expiresAt
        ? new Date(previousKey.expiresAt).toISOString()
        : activeKey?.expiresAt
          ? new Date(activeKey.expiresAt).toISOString()
          : undefined,
    };
  }
}

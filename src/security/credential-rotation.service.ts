import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type CredentialDomain =
  | 'siwe'
  | 'webhook'
  | 'encryption'
  | 'provider'
  | 'database';

export interface CredentialKeyVersion {
  keyId: string;
  secret: string; // NEVER LOGGED OR EXPOSED IN STATUS
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
  // NOTE: Secrets are EXPLICITLY excluded from status views!
}

@Injectable()
export class CredentialRotationService {
  private readonly logger = new Logger(CredentialRotationService.name);
  private readonly domains = new Map<CredentialDomain, DomainCredentialState>();
  private readonly defaultOverlapWindowMs = 24 * 60 * 60 * 1000; // 24 hours bounded overlap

  constructor(private readonly configService: ConfigService) {
    const domainsList: CredentialDomain[] = [
      'siwe',
      'webhook',
      'encryption',
      'provider',
      'database',
    ];
    for (const domain of domainsList) {
      this.initializeDomain(domain);
    }
  }

  private initializeDomain(domain: CredentialDomain): void {
    const defaultKeyId = `${domain}-v1`;
    const defaultSecret =
      this.configService.get<string>(
        `${domain.toUpperCase()}_SECRET`,
        `default-${domain}-secret-${Math.random()}`,
      );

    const keys = new Map<string, CredentialKeyVersion>();
    const keyVersion: CredentialKeyVersion = {
      keyId: defaultKeyId,
      secret: defaultSecret,
      createdAt: Date.now(),
      status: 'active',
    };
    keys.set(defaultKeyId, keyVersion);

    this.domains.set(domain, {
      domain,
      activeKeyId: defaultKeyId,
      keys,
      overlapWindowMs: this.defaultOverlapWindowMs,
    });
  }

  /**
   * Rotate credential for a domain atomically with bounded overlap.
   */
  rotateCredential(
    domain: CredentialDomain,
    newKeyId: string,
    newSecret: string,
    overlapMs?: number,
  ): { activeKeyId: string; previousKeyId?: string } {
    if (!newKeyId || !newSecret) {
      throw new BadRequestException('Key ID and secret are required for rotation');
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

    // Keys never enter logs
    this.logger.log(
      `Credential rotated for domain [${domain}]: active=${newKeyId}, previous=${currentActiveId}`,
    );

    return {
      activeKeyId: newKeyId,
      previousKeyId: currentActiveId,
    };
  }

  /**
   * Rollback credential rotation to the previous key.
   */
  rollbackCredential(
    domain: CredentialDomain,
  ): { activeKeyId: string; rolledBackFrom: string } {
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

    this.logger.warn(
      `Credential rollback executed for domain [${domain}]: restored=${targetKeyId}, rolledBackFrom=${previousActive}`,
    );

    return {
      activeKeyId: targetKeyId,
      rolledBackFrom: previousActive,
    };
  }

  /**
   * Revoke a specific key ID immediately.
   */
  revokeKey(domain: CredentialDomain, keyId: string): void {
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
        `CRITICAL: Active key [${keyId}] revoked for domain [${domain}]! Service failing closed.`,
      );
      state.activeKeyId = ''; // Fail closed
    }

    if (state.previousKeyId === keyId) {
      state.previousKeyId = undefined;
    }

    this.logger.warn(`Key [${keyId}] explicitly revoked for domain [${domain}]`);
  }

  /**
   * Verify and retrieve secret for a given key ID (or current active key if keyId omitted).
   * Fails closed on stale, missing, ambiguous, expired, revoked, or unknown key IDs.
   * NEVER logs or leaks secrets.
   */
  getSecret(domain: CredentialDomain, keyId?: string): string {
    const state = this.domains.get(domain);
    if (!state) {
      throw new UnauthorizedException(
        `Unauthorized or invalid credential domain: ${domain}`,
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

  /**
   * Get safe status view without leaking secret material (Keys never enter logs or status).
   */
  getStatus(
    domain?: CredentialDomain,
  ): CredentialStatusView | CredentialStatusView[] {
    if (domain) {
      const state = this.domains.get(domain);
      if (!state) {
        throw new BadRequestException(`Unknown credential domain: ${domain}`);
      }
      return {
        domain: state.domain,
        activeKeyId: state.activeKeyId,
        previousKeyId: state.previousKeyId,
        totalKeys: state.keys.size,
        hasOverlap: !!state.previousKeyId,
      };
    }

    const statuses: CredentialStatusView[] = [];
    for (const [_, state] of this.domains) {
      statuses.push({
        domain: state.domain,
        activeKeyId: state.activeKeyId,
        previousKeyId: state.previousKeyId,
        totalKeys: state.keys.size,
        hasOverlap: !!state.previousKeyId,
      });
    }
    return statuses;
  }
}

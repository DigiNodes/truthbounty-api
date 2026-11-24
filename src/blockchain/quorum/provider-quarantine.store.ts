import { Injectable, Logger } from '@nestjs/common';
import {
  DivergenceKind,
  QuarantineRecord,
  QuorumPolicy,
} from './interfaces';

/**
 * ProviderQuarantineStore — V2-BE-051
 *
 * In-memory quarantine state machine, per replica:
 *
 *   TRUSTED  ──(divergence observed)──►  QUARANTINED
 *   QUARANTINED ──(quarantineMs elapsed)──►  RECOVERING
 *   RECOVERING ──(freshAgreements ≥ required)──►  TRUSTED
 *   RECOVERING ──(divergence observed)──►  QUARANTINED (fresh reset)
 *
 * Two invariants drive the whole design:
 *
 *   1. `isQuarantined()` returns true from the moment a divergence is
 *      recorded **until** the provider is fully released — not merely
 *      until quarantineMs elapses. Time alone never trusts a provider;
 *      recovery also requires fresh agreement.
 *
 *   2. `recordAgreement()` only counts while the quarantine window has
 *      elapsed. This is what "fresh" means: agreements observed during
 *      the window itself do not accrue.
 */
@Injectable()
export class ProviderQuarantineStore {
  private readonly logger = new Logger(ProviderQuarantineStore.name);
  private readonly records = new Map<string, QuarantineRecord>();

  /** Mark a provider as quarantined. Idempotent for the same kind. */
  quarantine(
    providerId: string,
    sanitizedUrl: string,
    kind: DivergenceKind,
  ): void {
    const existing = this.records.get(providerId);
    const now = Date.now();

    if (existing && existing.kind === kind) {
      // Same divergence — preserve the original quarantinedAt so the
      // window doesn't restart just because we observed it again.
      existing.freshAgreements = 0;
      return;
    }

    this.records.set(providerId, {
      providerId,
      sanitizedUrl,
      kind,
      quarantinedAt: now,
      freshAgreements: 0,
    });
    this.logger.warn(`RPC provider ${sanitizedUrl} quarantined: ${kind}`);
  }

  /**
   * True until the provider is fully released — i.e. while the quarantine
   * window has not elapsed **or** fresh-agreement quorum is not yet met.
   *
   * A provider is only re-trusted when `recordAgreement()` deletes its
   * record, and only that method can do so.
   */
  isQuarantined(providerId: string, policy: QuorumPolicy): boolean {
    const r = this.records.get(providerId);
    if (!r) return false;

    const windowElapsed =
      Date.now() - r.quarantinedAt >= policy.quarantineMs;

    if (!windowElapsed) return true; // still inside window
    return r.freshAgreements < policy.recoveryAgreementsRequired; // recovering
  }

  /**
   * Record a fresh agreement. Only counts when the quarantine window has
   * elapsed. Returns true iff the provider was just released.
   */
  recordAgreement(providerId: string, policy: QuorumPolicy): boolean {
    const r = this.records.get(providerId);
    if (!r) return false;
    if (Date.now() - r.quarantinedAt < policy.quarantineMs) return false;

    r.freshAgreements += 1;
    if (r.freshAgreements >= policy.recoveryAgreementsRequired) {
      this.records.delete(providerId);
      this.logger.log(
        `RPC provider ${r.sanitizedUrl} recovered after ${r.freshAgreements} fresh agreement(s)`,
      );
      return true;
    }
    return false;
  }

  /** Reset the fresh-agreement counter — divergence during recovery. */
  resetAgreement(providerId: string): void {
    const r = this.records.get(providerId);
    if (r) r.freshAgreements = 0;
  }

  snapshot(): QuarantineRecord[] {
    return Array.from(this.records.values());
  }

  clear(): void {
    this.records.clear();
  }
}

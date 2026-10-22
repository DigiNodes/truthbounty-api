import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WalletIdentity } from './entities/wallet-identity.entity';
import { AuthSessionService } from './auth-session.service';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import {
  AuditActionType,
  AuditEntityType,
} from '../audit/entities/audit-log.entity';

/**
 * V2-BE-103: Enforce Wallet-to-User Identity Integrity
 *
 * Guarantees one wallet address (per chain) belongs to exactly one user:
 *
 * - bind: idempotent for the existing owner, ConflictException for anyone else.
 *   The unique index is the backstop, so a race resolves to a conflict rather
 *   than a duplicate binding.
 * - resolveUser: the only sanctioned way to go from wallet to user identity.
 * - assertOwnership: fail-closed check for callers that act on behalf of a
 *   wallet — an unbound wallet is a 404, someone else's wallet is a 403.
 * - unbind: only the owning user may release a wallet, and releasing it
 *   revokes every live session for that wallet so a stolen token cannot
 *   survive an unlink (fail closed).
 * - relink: re-establishing a binding requires a live session bound to the
 *   exact wallet+chain being relinked, and every attempt (allowed or denied)
 *   is written to the tamper-evident audit trail.
 *
 * Nothing here can reassign an existing binding. Moving a wallet between users
 * would be an explicit, auditable operation, and there isn't one.
 *
 * PREWAVE-BE-060 (#653): identity keys carry chain context; one session can
 * never change principal silently; relink is authenticated and audited;
 * cross-user access fails closed.
 */

/** Largest value a 32-bit `integer` column can store. */
const MAX_CHAIN_ID = 2147483647;

export interface BindResult {
  identity: WalletIdentity;
  /** True when this wallet was already bound to the same user. */
  alreadyBound: boolean;
}

@Injectable()
export class WalletIdentityService {
  private readonly logger = new Logger(WalletIdentityService.name);

  constructor(
    @InjectRepository(WalletIdentity)
    private readonly repo: Repository<WalletIdentity>,
    private readonly authSessions: AuthSessionService,
    private readonly auditTrail: AuditTrailService,
  ) {}

  /**
   * Bind a wallet to a user. Safe to call twice: the second call for the same
   * user is a no-op, and a call for a different user is rejected.
   */
  async bind(
    userId: string,
    walletAddress: string,
    chainId: number,
  ): Promise<BindResult> {
    this.assertValidUserId(userId);
    this.assertValidAddress(walletAddress);
    this.assertValidChainId(chainId);

    const normalized = walletAddress.toLowerCase();
    const existing = await this.repo.findOne({
      where: { walletAddress: normalized, chainId },
    });

    if (existing) {
      if (existing.userId !== userId) {
        // Fail closed — never silently move a wallet to a second identity.
        await this.auditRejectedBind(
          userId,
          normalized,
          chainId,
          'already_bound',
        );
        throw new ConflictException(
          `Wallet ${normalized} on chain ${chainId} is already bound to another user`,
        );
      }
      this.logger.debug(
        `Wallet ${normalized}/${chainId} already bound to user ${userId} — no-op`,
      );
      return { identity: existing, alreadyBound: true };
    }

    try {
      const saved = await this.repo.save(
        this.repo.create({ userId, walletAddress: normalized, chainId }),
      );
      await this.auditTrail.log({
        actionType: AuditActionType.WALLET_LINKED,
        entityType: AuditEntityType.WALLET,
        entityId: saved.id,
        userId,
        walletAddress: normalized,
        description: 'Wallet identity bound',
        metadata: { chainId, relink: false },
      });
      this.logger.log(
        `Wallet ${normalized} (chainId=${chainId}) bound to user ${userId}`,
      );
      return { identity: saved, alreadyBound: false };
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }

      // A concurrent bind won the race and the unique index caught ours.
      // Re-read to decide the outcome: if the winner bound this wallet to the
      // same user then the caller got exactly what it asked for and the call
      // stays idempotent. Only a different owner is a genuine conflict.
      const winner = await this.repo.findOne({
        where: { walletAddress: normalized, chainId },
      });

      if (winner) {
        if (winner.userId === userId) {
          return { identity: winner, alreadyBound: true };
        }
        await this.auditRejectedBind(userId, normalized, chainId, 'lost_race');
        throw new ConflictException(
          `Wallet ${normalized} on chain ${chainId} is already bound to another user`,
        );
      }

      // The competing row disappeared between the failed insert and this read,
      // so there is nothing to adopt and nothing to report as owned.
      throw new ConflictException(
        `Wallet ${normalized} on chain ${chainId} was bound concurrently`,
      );
    }
  }

  /**
   * Re-establish a binding for a wallet the caller controls.
   *
   * PREWAVE-BE-060: relink is an authenticated, audited operation — it is not
   * a back door around the conflict checks in {@link bind}:
   *
   * 1. The caller must present a live session bound to the exact wallet and
   *    chain being relinked. A session for another wallet, another chain, or a
   *    revoked/stolen token fails closed before any state changes.
   * 2. Because {@link unbind} revokes every session for an unlinked wallet,
   *    relinking after an unlink always requires fresh authentication.
   * 3. Every attempt — allowed or denied — lands in the audit trail.
   */
  async relink(
    sessionToken: string,
    userId: string,
    walletAddress: string,
    chainId: number,
  ): Promise<BindResult> {
    this.assertValidUserId(userId);
    this.assertValidAddress(walletAddress);
    this.assertValidChainId(chainId);

    const normalized = walletAddress.toLowerCase();

    // Fails closed on unknown/expired/revoked tokens and on any principal
    // mismatch (wallet or chain) before a single row is read or written.
    const session = await this.authSessions.validateForPrincipal(
      sessionToken,
      normalized,
      chainId,
    );

    try {
      const result = await this.bind(userId, normalized, chainId);
      await this.auditTrail.log({
        actionType: AuditActionType.WALLET_LINKED,
        entityType: AuditEntityType.WALLET,
        entityId: result.identity.id,
        userId,
        walletAddress: normalized,
        description: 'Wallet identity relinked (session-authenticated)',
        metadata: {
          chainId,
          relink: true,
          sessionId: session.id,
          alreadyBound: result.alreadyBound,
        },
      });
      this.logger.log(
        `Wallet ${normalized} (chainId=${chainId}) relinked to user ${userId}`,
      );
      return result;
    } catch (error) {
      // Denied relinks (conflicts against another owner) stay auditable, but
      // an audit-backend failure must never replace the security outcome.
      try {
        await this.auditTrail.log({
          actionType: AuditActionType.WALLET_LINKED,
          entityType: AuditEntityType.WALLET,
          entityId: normalized,
          userId,
          walletAddress: normalized,
          description: 'Wallet relink denied',
          metadata: {
            chainId,
            relink: true,
            sessionId: session.id,
            outcome: 'denied',
            reason: error instanceof Error ? error.name : 'unknown',
          },
        });
      } catch (auditError) {
        this.logger.error('Failed to audit denied wallet relink', auditError);
      }
      throw error;
    }
  }

  /** The user identity that owns this wallet, or null when nothing is bound. */
  async resolveUser(
    walletAddress: string,
    chainId: number,
  ): Promise<string | null> {
    this.assertValidAddress(walletAddress);
    this.assertValidChainId(chainId);

    const identity = await this.repo.findOne({
      where: { walletAddress: walletAddress.toLowerCase(), chainId },
    });

    return identity?.userId ?? null;
  }

  /**
   * Confirm a wallet belongs to this user before acting on their behalf.
   * Throws for an unbound wallet and for someone else's wallet alike.
   */
  async assertOwnership(
    userId: string,
    walletAddress: string,
    chainId: number,
  ): Promise<WalletIdentity> {
    this.assertValidUserId(userId);

    const identity = await this.findOneOrThrow(walletAddress, chainId);

    if (identity.userId !== userId) {
      throw new ForbiddenException(
        `Wallet ${identity.walletAddress} is bound to a different user`,
      );
    }

    return identity;
  }

  /** Every wallet bound to a user, oldest first. */
  async listForUser(userId: string): Promise<WalletIdentity[]> {
    this.assertValidUserId(userId);

    return this.repo.find({ where: { userId }, order: { createdAt: 'asc' } });
  }

  /**
   * Release a wallet. Only the owning user may do this.
   *
   * PREWAVE-BE-060: unlink revokes every live session for the wallet *before*
   * dropping the binding, so a stolen bearer token cannot outlive the unlink.
   * If revocation fails the binding stays in place (fail closed — an unlink
   * that might leave live sessions behind is refused rather than half-done).
   */
  async unbind(
    userId: string,
    walletAddress: string,
    chainId: number,
  ): Promise<WalletIdentity> {
    this.assertValidUserId(userId);

    const identity = await this.findOneOrThrow(walletAddress, chainId);

    if (identity.userId !== userId) {
      throw new ForbiddenException(
        `Wallet ${identity.walletAddress} is bound to a different user`,
      );
    }

    // Kill live sessions first: revocation before removal is the safe order.
    await this.authSessions.revokeAll(identity.walletAddress);

    await this.repo.remove(identity);
    await this.auditTrail.log({
      actionType: AuditActionType.WALLET_UNLINKED,
      entityType: AuditEntityType.WALLET,
      entityId: identity.id,
      userId,
      walletAddress: identity.walletAddress,
      description: 'Wallet identity unbound; live sessions revoked',
      metadata: { chainId },
    });
    this.logger.log(
      `Wallet ${identity.walletAddress} (chainId=${chainId}) unbound from user ${userId}`,
    );

    return identity;
  }

  /** Denied binds stay visible in the audit trail, not just in the logs. */
  private async auditRejectedBind(
    userId: string,
    walletAddress: string,
    chainId: number,
    reason: 'already_bound' | 'lost_race',
  ): Promise<void> {
    try {
      await this.auditTrail.log({
        actionType: AuditActionType.WALLET_LINKED,
        entityType: AuditEntityType.WALLET,
        entityId: walletAddress,
        userId,
        walletAddress,
        description: 'Wallet bind denied — already owned by another user',
        metadata: { chainId, outcome: 'denied', reason },
      });
    } catch (auditError) {
      // The conflict still stands even if the trail write failed.
      this.logger.error('Failed to audit denied wallet bind', auditError);
    }
  }

  private async findOneOrThrow(
    walletAddress: string,
    chainId: number,
  ): Promise<WalletIdentity> {
    this.assertValidAddress(walletAddress);
    this.assertValidChainId(chainId);

    const normalized = walletAddress.toLowerCase();
    const identity = await this.repo.findOne({
      where: { walletAddress: normalized, chainId },
    });

    if (!identity) {
      throw new NotFoundException(
        `Wallet ${normalized} on chain ${chainId} is not bound to any user`,
      );
    }

    return identity;
  }

  private assertValidUserId(userId: string): void {
    if (typeof userId !== 'string' || userId.trim().length === 0) {
      throw new BadRequestException('userId must be a non-empty string');
    }
  }

  private assertValidAddress(address: string): void {
    if (typeof address !== 'string' || !address.match(/^0x[0-9a-fA-F]{40}$/)) {
      throw new BadRequestException('Invalid EVM wallet address');
    }
  }

  /**
   * The column is a 32-bit `integer`, so accept only what it can actually
   * hold. A larger chain id would otherwise pass validation here and then fail
   * during persistence, which is not a fail-closed outcome at the boundary.
   */
  private assertValidChainId(chainId: number): void {
    if (!Number.isInteger(chainId) || chainId <= 0 || chainId > MAX_CHAIN_ID) {
      throw new BadRequestException(
        `chainId must be a positive integer no greater than ${MAX_CHAIN_ID}`,
      );
    }
  }

  /** Postgres, SQLite and MySQL each report a unique violation their own way. */
  private isUniqueViolation(error: unknown): boolean {
    const candidate = error as {
      code?: string;
      driverError?: { code?: string };
    };
    const code = candidate?.driverError?.code ?? candidate?.code;

    return (
      code === '23505' ||
      code === 'SQLITE_CONSTRAINT' ||
      code === 'ER_DUP_ENTRY'
    );
  }
}

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Admin, AdminRole, AdminRoleHierarchy } from '../../admin/entities/admin.entity';
import { ExportCursor } from '../entities/export-cursor.entity';

/**
 * Guards that are allowed to call the cursor-based export endpoint.
 *
 * Fail-closed invariants (PREWAVE-BE-033):
 *   1. No authenticated user → `UnauthorizedException` (401).
 *   2. User authenticated but not an active admin → `ForbiddenException` (403).
 *   3. Admin role below AUDITOR → `ForbiddenException` (403).
 *   4. Request carries a `cursorId` but the cursor is:
 *       a. Not found in the database        → `ForbiddenException` (403)
 *          (cursor-not-found is treated the same as forbidden to avoid
 *          leaking information about cursor existence to a different requester)
 *       b. Owned by a different requester   → `ForbiddenException` (403)
 *       c. Status !== 'active'              → `ForbiddenException` (403)
 *       d. `expiresAt` in the past          → `ForbiddenException` (403)
 *   5. Any unexpected error → fails closed with `ForbiddenException` (403).
 *
 * This guard is intended to be composed AFTER `AdminGuard` (which
 * populates `request.admin`) but BEFORE the route handler.
 */
@Injectable()
export class AuditExportCapabilityGuard implements CanActivate {
  /** Minimum admin role required to export audit logs. */
  private static readonly REQUIRED_ROLE = AdminRole.AUDITOR;

  constructor(
    @InjectRepository(Admin)
    private readonly adminRepo: Repository<Admin>,
    @InjectRepository(ExportCursor)
    private readonly exportCursorRepo: Repository<ExportCursor>,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    try {
      return await this.evaluate(request);
    } catch (error) {
      // Re-throw known HTTP exceptions unchanged
      if (
        error instanceof UnauthorizedException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      // Unknown error: fail closed
      throw new ForbiddenException(
        'Export capability check failed; access denied',
      );
    }
  }

  private async evaluate(request: any): Promise<boolean> {
    // ── 1. Authentication check ──────────────────────────────────────────────
    const user = request.user;
    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const walletAddress = (user.address ?? user.walletAddress ?? '').toLowerCase();
    if (!walletAddress) {
      throw new UnauthorizedException('Wallet address not found in token');
    }

    // ── 2. Admin record lookup ───────────────────────────────────────────────
    const admin = await this.adminRepo.findOne({
      where: { walletAddress, isActive: true },
    });

    if (!admin) {
      throw new ForbiddenException('Admin access required');
    }

    if (!admin.isActive) {
      throw new ForbiddenException('Admin account is deactivated');
    }

    // ── 3. Role-level check ──────────────────────────────────────────────────
    const requiredLevel =
      AdminRoleHierarchy[AuditExportCapabilityGuard.REQUIRED_ROLE];
    const actualLevel = AdminRoleHierarchy[admin.role];

    if (actualLevel === undefined || actualLevel < requiredLevel) {
      throw new ForbiddenException(
        `Insufficient role for audit export. Required: ${AuditExportCapabilityGuard.REQUIRED_ROLE}. Current: ${admin.role}`,
      );
    }

    // Attach admin to request so the handler can read requesterId
    request.admin = admin;

    // ── 4. Cursor-level check (only when resuming) ───────────────────────────
    const cursorId: string | undefined =
      request.query?.cursorId ?? request.body?.cursorId;

    if (cursorId) {
      await this.verifyCursorOwnership(cursorId, admin.id);
    }

    return true;
  }

  private async verifyCursorOwnership(
    cursorId: string,
    requesterId: string,
  ): Promise<void> {
    const cursor = await this.exportCursorRepo.findOne({
      where: { id: cursorId },
    });

    // Not found → fail closed (same error as wrong owner, no info leak)
    if (!cursor) {
      throw new ForbiddenException('Export cursor not accessible');
    }

    // Wrong owner → fail closed
    if (cursor.requesterId !== requesterId) {
      throw new ForbiddenException('Export cursor not accessible');
    }

    // Expired (by timestamp) → fail closed
    if (cursor.expiresAt <= new Date()) {
      throw new ForbiddenException('Export cursor has expired');
    }

    // Any non-active status → fail closed
    if (cursor.status !== 'active') {
      throw new ForbiddenException(
        `Export cursor is not in active state (current: ${cursor.status})`,
      );
    }
  }
}

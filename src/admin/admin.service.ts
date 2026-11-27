import {
  Injectable,
  ConflictException,
  NotFoundException,
  Logger,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Admin, AdminRole } from './entities/admin.entity';
import {
  CreateAdminDto,
  UpdateAdminRoleDto,
  UpdateAdminStatusDto,
} from './dto/admin.dto';
import {
  canManageAdmins,
  canGrantAdminRole,
  canModifyAdminAccount,
} from './admin.policy';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import {
  AuditActionType,
  AuditCategory,
  AuditSeverity,
  AuditEntityType,
} from '../audit/entities/audit-log.entity';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(Admin)
    private readonly adminRepo: Repository<Admin>,
    @Optional()
    private readonly auditTrailService?: AuditTrailService,
  ) {}

  async create(
    createAdminDto: CreateAdminDto,
    requestedBy: Admin,
  ): Promise<Admin> {
    const targetRole = createAdminDto.role ?? AdminRole.AUDITOR;

    if (!canManageAdmins(requestedBy.role)) {
      await this.recordAuditLog({
        actionType: AuditActionType.ROLE_ASSIGNED,
        category: AuditCategory.SECURITY,
        severity: AuditSeverity.HIGH,
        actor: requestedBy,
        targetWallet: createAdminDto.walletAddress.toLowerCase(),
        previousRole: null,
        newRole: targetRole,
        outcome: 'denied',
        reason: 'Insufficient permissions to create admins',
        description: `Admin creation denied: actor ${requestedBy.role} lacks permission to create admins`,
      });
      throw new ForbiddenException('Insufficient permissions to create admins');
    }

    if (!canGrantAdminRole(requestedBy.role, targetRole)) {
      await this.recordAuditLog({
        actionType: AuditActionType.ROLE_ASSIGNED,
        category: AuditCategory.SECURITY,
        severity: AuditSeverity.CRITICAL,
        actor: requestedBy,
        targetWallet: createAdminDto.walletAddress.toLowerCase(),
        previousRole: null,
        newRole: targetRole,
        outcome: 'denied',
        reason: 'Cannot grant role outside approved grant policy',
        description: `Admin creation denied: actor ${requestedBy.role} attempted unauthorized grant of role ${targetRole}`,
      });
      throw new ForbiddenException(
        `Insufficient permissions to grant role ${targetRole}`,
      );
    }

    const existing = await this.adminRepo.findOne({
      where: { walletAddress: createAdminDto.walletAddress.toLowerCase() },
    });

    if (existing) {
      throw new ConflictException(
        'Admin with this wallet address already exists',
      );
    }

    const admin = this.adminRepo.create({
      walletAddress: createAdminDto.walletAddress.toLowerCase(),
      role: targetRole,
      isActive: true,
    });

    const saved = await this.adminRepo.save(admin);
    this.logger.log(`Admin created: ${saved.id} with role ${saved.role}`);

    await this.recordAuditLog({
      actionType: AuditActionType.ROLE_ASSIGNED,
      category: AuditCategory.ADMINISTRATIVE,
      severity: AuditSeverity.HIGH,
      actor: requestedBy,
      targetId: saved.id,
      targetWallet: saved.walletAddress,
      previousRole: null,
      newRole: saved.role,
      outcome: 'success',
      beforeState: undefined,
      afterState: {
        id: saved.id,
        walletAddress: saved.walletAddress,
        role: saved.role,
        isActive: saved.isActive,
      },
      description: `Admin created: ${saved.id} with role ${saved.role}`,
    });

    return saved;
  }

  async findAll(
    page = 1,
    limit = 20,
  ): Promise<{ data: Admin[]; total: number; page: number; limit: number }> {
    const [data, total] = await this.adminRepo.findAndCount({
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return { data, total, page, limit };
  }

  async findById(id: string): Promise<Admin> {
    const admin = await this.adminRepo.findOneBy({ id });
    if (!admin) {
      throw new NotFoundException(`Admin with ID ${id} not found`);
    }
    return admin;
  }

  async findByWallet(walletAddress: string): Promise<Admin | null> {
    return this.adminRepo.findOne({
      where: { walletAddress: walletAddress.toLowerCase(), isActive: true },
    });
  }

  async updateRole(
    id: string,
    updateRoleDto: UpdateAdminRoleDto,
    requestedBy: Admin,
  ): Promise<Admin> {
    const targetRole = updateRoleDto.role;

    if (!canManageAdmins(requestedBy.role)) {
      await this.recordAuditLog({
        actionType: AuditActionType.ROLE_ASSIGNED,
        category: AuditCategory.SECURITY,
        severity: AuditSeverity.HIGH,
        actor: requestedBy,
        targetId: id,
        newRole: targetRole,
        outcome: 'denied',
        reason: 'Insufficient permissions to update admin roles',
        description: `Admin role update denied: actor ${requestedBy.role} lacks permission to update admin roles`,
      });
      throw new ForbiddenException(
        'Insufficient permissions to update admin roles',
      );
    }

    if (!canGrantAdminRole(requestedBy.role, targetRole)) {
      await this.recordAuditLog({
        actionType: AuditActionType.ROLE_ASSIGNED,
        category: AuditCategory.SECURITY,
        severity: AuditSeverity.CRITICAL,
        actor: requestedBy,
        targetId: id,
        newRole: targetRole,
        outcome: 'denied',
        reason: 'Cannot grant role outside approved grant policy',
        description: `Admin role update denied: actor ${requestedBy.role} attempted unauthorized promotion to ${targetRole}`,
      });
      throw new ForbiddenException(
        `Insufficient permissions to grant role ${targetRole}`,
      );
    }

    return this.executeWithTarget(id, async (admin, repo) => {
      if (!canModifyAdminAccount(requestedBy.role, admin.role)) {
        await this.recordAuditLog({
          actionType: AuditActionType.ROLE_ASSIGNED,
          category: AuditCategory.SECURITY,
          severity: AuditSeverity.CRITICAL,
          actor: requestedBy,
          targetId: admin.id,
          targetWallet: admin.walletAddress,
          previousRole: admin.role,
          newRole: targetRole,
          outcome: 'denied',
          reason: 'Cannot modify a super admin',
          description: `Admin role update denied: actor ${requestedBy.role} attempted to modify super admin ${admin.id}`,
        });
        throw new ForbiddenException('Cannot modify a super admin');
      }

      if (!canGrantAdminRole(requestedBy.role, targetRole)) {
        await this.recordAuditLog({
          actionType: AuditActionType.ROLE_ASSIGNED,
          category: AuditCategory.SECURITY,
          severity: AuditSeverity.CRITICAL,
          actor: requestedBy,
          targetId: admin.id,
          targetWallet: admin.walletAddress,
          previousRole: admin.role,
          newRole: targetRole,
          outcome: 'denied',
          reason: 'Cannot grant role outside approved grant policy',
          description: `Admin role update denied: actor ${requestedBy.role} attempted unauthorized promotion to ${targetRole}`,
        });
        throw new ForbiddenException(
          `Insufficient permissions to grant role ${targetRole}`,
        );
      }

      const previousRole = admin.role;
      admin.role = targetRole;
      const saved = await repo.save(admin);
      this.logger.log(`Admin ${id} role updated to ${targetRole}`);

      await this.recordAuditLog({
        actionType: AuditActionType.ROLE_ASSIGNED,
        category: AuditCategory.ADMINISTRATIVE,
        severity: AuditSeverity.HIGH,
        actor: requestedBy,
        targetId: saved.id,
        targetWallet: saved.walletAddress,
        previousRole,
        newRole: saved.role,
        outcome: 'success',
        beforeState: { role: previousRole },
        afterState: { role: saved.role },
        description: `Admin ${id} role updated from ${previousRole} to ${saved.role}`,
      });

      return saved;
    });
  }

  async updateStatus(
    id: string,
    updateStatusDto: UpdateAdminStatusDto,
    requestedBy: Admin,
  ): Promise<Admin> {
    if (!canManageAdmins(requestedBy.role)) {
      await this.recordAuditLog({
        actionType: AuditActionType.ADMIN_ACTION,
        category: AuditCategory.SECURITY,
        severity: AuditSeverity.HIGH,
        actor: requestedBy,
        targetId: id,
        outcome: 'denied',
        reason: 'Insufficient permissions to update admin status',
        description: `Admin status update denied: actor ${requestedBy.role} lacks permission to update status`,
      });
      throw new ForbiddenException(
        'Insufficient permissions to update admin status',
      );
    }

    return this.executeWithTarget(id, async (admin, repo) => {
      if (!canModifyAdminAccount(requestedBy.role, admin.role)) {
        await this.recordAuditLog({
          actionType: AuditActionType.ADMIN_ACTION,
          category: AuditCategory.SECURITY,
          severity: AuditSeverity.CRITICAL,
          actor: requestedBy,
          targetId: admin.id,
          targetWallet: admin.walletAddress,
          previousRole: admin.role,
          outcome: 'denied',
          reason: 'Cannot modify a super admin',
          description: `Admin status update denied: actor ${requestedBy.role} attempted to modify super admin status ${admin.id}`,
        });
        throw new ForbiddenException('Cannot modify a super admin');
      }

      const previousStatus = admin.isActive;
      admin.isActive = updateStatusDto.isActive;
      const saved = await repo.save(admin);
      this.logger.log(
        `Admin ${id} status updated to ${updateStatusDto.isActive}`,
      );

      await this.recordAuditLog({
        actionType: AuditActionType.ADMIN_ACTION,
        category: AuditCategory.ADMINISTRATIVE,
        severity: AuditSeverity.HIGH,
        actor: requestedBy,
        targetId: saved.id,
        targetWallet: saved.walletAddress,
        previousRole: saved.role,
        newRole: saved.role,
        outcome: 'success',
        beforeState: { isActive: previousStatus },
        afterState: { isActive: saved.isActive },
        description: `Admin ${id} status updated to ${updateStatusDto.isActive}`,
      });

      return saved;
    });
  }

  /**
   * Records a successful admin login for an already-verified wallet principal.
   * Only active admins are eligible; inactive or unknown identities are
   * rejected with the same non-enumerating response.
   */
  async recordLogin(walletAddress: string): Promise<Admin> {
    const admin = await this.adminRepo.findOne({
      where: { walletAddress: walletAddress.toLowerCase(), isActive: true },
    });

    if (!admin) {
      throw new NotFoundException('Admin not found');
    }

    admin.lastLoginAt = new Date();
    return this.adminRepo.save(admin);
  }

  canManageAdmins(role: AdminRole): boolean {
    return canManageAdmins(role);
  }

  canGrantRole(actorRole: AdminRole, targetRole: AdminRole): boolean {
    return canGrantAdminRole(actorRole, targetRole);
  }

  canModifyAdmin(actorRole: AdminRole, targetRole: AdminRole): boolean {
    return canModifyAdminAccount(actorRole, targetRole);
  }

  private async executeWithTarget<T>(
    id: string,
    operation: (admin: Admin, repo: Repository<Admin>) => Promise<T>,
  ): Promise<T> {
    const manager = this.adminRepo.manager;
    if (
      manager &&
      typeof (manager as unknown as Record<string, unknown>).transaction ===
        'function'
    ) {
      return manager.transaction(async (txManager) => {
        const repo = txManager.getRepository(Admin);
        const admin = await repo.findOneBy({ id });
        if (!admin) {
          throw new NotFoundException(`Admin with ID ${id} not found`);
        }
        return operation(admin, repo);
      });
    }

    const admin = await this.findById(id);
    return operation(admin, this.adminRepo);
  }

  private async recordAuditLog(params: {
    actionType: AuditActionType;
    category: AuditCategory;
    severity: AuditSeverity;
    actor: Admin;
    targetId?: string;
    targetWallet?: string;
    previousRole?: AdminRole | null;
    newRole?: AdminRole | null;
    outcome: 'success' | 'denied';
    reason?: string;
    beforeState?: Record<string, any>;
    afterState?: Record<string, any>;
    description: string;
  }): Promise<void> {
    if (!this.auditTrailService) {
      return;
    }
    try {
      await this.auditTrailService.log({
        actionType: params.actionType,
        entityType: AuditEntityType.ADMIN,
        entityId: params.targetId || params.targetWallet || params.actor.id,
        userId: params.actor.id,
        walletAddress: params.actor.walletAddress,
        severity: params.severity,
        category: params.category,
        description: params.description,
        beforeState:
          params.beforeState ??
          (params.previousRole ? { role: params.previousRole } : undefined),
        afterState:
          params.afterState ??
          (params.newRole ? { role: params.newRole } : undefined),
        metadata: {
          actorId: params.actor.id,
          actorWallet: params.actor.walletAddress,
          actorRole: params.actor.role,
          targetId: params.targetId,
          targetWallet: params.targetWallet,
          previousRole: params.previousRole ?? null,
          newRole: params.newRole ?? null,
          outcome: params.outcome,
          reason: params.reason,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to persist audit log for admin action: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

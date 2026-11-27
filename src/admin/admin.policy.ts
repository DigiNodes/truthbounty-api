import { AdminRole } from './entities/admin.entity';

/**
 * Explicit grant policy defining which admin-operator roles each actor role
 * is authorized to assign, create, or promote to.
 *
 * Invariant: Grant authority is decoupled from the numeric role hierarchy
 * to prevent privilege escalation. An administrator (80) cannot create or
 * promote an account to super_admin (100) or alter an existing super_admin.
 */
export const ADMIN_ROLE_GRANT_POLICY: Record<AdminRole, readonly AdminRole[]> =
  {
    [AdminRole.SUPER_ADMIN]: [
      AdminRole.SUPER_ADMIN,
      AdminRole.ADMINISTRATOR,
      AdminRole.SECURITY_ANALYST,
      AdminRole.GOVERNANCE_OPERATOR,
      AdminRole.MODERATOR,
      AdminRole.AUDITOR,
    ],
    [AdminRole.ADMINISTRATOR]: [
      AdminRole.ADMINISTRATOR,
      AdminRole.SECURITY_ANALYST,
      AdminRole.GOVERNANCE_OPERATOR,
      AdminRole.MODERATOR,
      AdminRole.AUDITOR,
    ],
    [AdminRole.SECURITY_ANALYST]: [],
    [AdminRole.GOVERNANCE_OPERATOR]: [],
    [AdminRole.MODERATOR]: [],
    [AdminRole.AUDITOR]: [],
  };

/**
 * Validates whether an actor role has baseline management privileges over admins.
 * Only SUPER_ADMIN and ADMINISTRATOR can manage admin accounts.
 */
export function canManageAdmins(actorRole: AdminRole): boolean {
  return (
    actorRole === AdminRole.SUPER_ADMIN || actorRole === AdminRole.ADMINISTRATOR
  );
}

/**
 * Validates whether an actor role is explicitly authorized to grant the target role
 * during creation or promotion.
 */
export function canGrantAdminRole(
  actorRole: AdminRole,
  targetRole: AdminRole,
): boolean {
  const allowed = ADMIN_ROLE_GRANT_POLICY[actorRole];
  return Boolean(allowed && allowed.includes(targetRole));
}

/**
 * Validates whether an actor role is authorized to modify an existing admin account
 * based on the target account's current role.
 * - Only SUPER_ADMIN and ADMINISTRATOR can manage admins.
 * - If target is SUPER_ADMIN, ONLY a SUPER_ADMIN can alter their role or status.
 */
export function canModifyAdminAccount(
  actorRole: AdminRole,
  targetAdminRole: AdminRole,
): boolean {
  if (!canManageAdmins(actorRole)) {
    return false;
  }
  if (
    targetAdminRole === AdminRole.SUPER_ADMIN &&
    actorRole !== AdminRole.SUPER_ADMIN
  ) {
    return false;
  }
  return true;
}

import { SetMetadata } from '@nestjs/common';
import { AppUserRole } from '../authorization-matrix';

export type { AppUserRole };

/**
 * Metadata key used by RolesGuard (app-user plane).
 * Distinct from admin_roles key used by the admin-plane RolesGuard.
 */
export const ROLES_KEY = 'roles';

/**
 * Restricts an endpoint to authenticated users whose Prisma UserRole
 * is included in the provided set.
 *
 * Must be paired with @UseGuards(JwtAuthGuard, RolesGuard) at the
 * controller or handler level.
 *
 * @example
 *   @Roles('moderator', 'admin')
 *   @UseGuards(JwtAuthGuard, RolesGuard)
 *   @Patch(':id/resolve')
 *   async resolve() {}
 */
export const Roles = (...roles: AppUserRole[]) => SetMetadata(ROLES_KEY, roles);

import { SetMetadata } from '@nestjs/common';
import { ADMIN_ONLY_KEY } from '../guards/admin.guard';

/**
 * Decorator to mark an endpoint as requiring admin privileges.
 *
 * Usage:
 *   @AdminOnly()
 *   @UseGuards(AdminGuard)
 *   @Delete('admin/users/:id')
 *   async deleteUser() {}
 */
export const AdminOnly = () => SetMetadata(ADMIN_ONLY_KEY, true);

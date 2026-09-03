import { SetMetadata } from '@nestjs/common';

export type AppUserRole = 'contributor' | 'moderator' | 'admin';

export const ROLES_KEY = 'roles';

export const Roles = (...roles: AppUserRole[]) => SetMetadata(ROLES_KEY, roles);

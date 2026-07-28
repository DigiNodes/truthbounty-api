import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'admin_permissions';
export const Permissions = (...permissions: string[]) => SetMetadata(PERMISSIONS_KEY, permissions);

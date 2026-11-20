import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../admin/guards/admin.guard';
import { RolesGuard } from '../admin/guards/roles.guard';
import { ROLES_KEY } from '../admin/decorators/roles.decorator';
import { AdminRole } from '../admin/entities/admin.entity';
import { SupportController } from './support.controller';
import { SupportRequestService } from './support.service';

describe('SupportController — DELETE /support/requests/:id', () => {
  const reflector = new Reflector();
  let service: SupportRequestService;
  let controller: SupportController;

  beforeEach(() => {
    service = new SupportRequestService();
    controller = new SupportController(service);
  });

  it('does not mark DELETE /support/requests/:id as @Public()', () => {
    const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      SupportController.prototype.deleteSupportRequest,
      SupportController,
    ]);
    expect(isPublic).toBeFalsy();
  });

  it('applies JwtAuthGuard, AdminGuard, RolesGuard and admin roles on DELETE /support/requests/:id', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      SupportController.prototype.deleteSupportRequest,
    );
    expect(guards).toEqual([JwtAuthGuard, AdminGuard, RolesGuard]);

    const roles = reflector.getAllAndOverride<AdminRole[]>(ROLES_KEY, [
      SupportController.prototype.deleteSupportRequest,
      SupportController,
    ]);
    expect(roles).toEqual([AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR]);
  });

  it('rejects unauthenticated and non-admin callers via AdminGuard', async () => {
    const adminRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    } as any;
    const adminGuard = new AdminGuard(adminRepo, reflector);

    const unauthCtx = {
      getHandler: () => SupportController.prototype.deleteSupportRequest,
      getClass: () => SupportController,
      switchToHttp: () => ({
        getRequest: () => ({ method: 'DELETE' }),
      }),
    } as any;

    await expect(adminGuard.canActivate(unauthCtx)).rejects.toThrow(
      UnauthorizedException,
    );

    const nonAdminCtx = {
      getHandler: () => SupportController.prototype.deleteSupportRequest,
      getClass: () => SupportController,
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'DELETE',
          user: { id: 'user-1', address: '0xnonadmin', role: 'contributor' },
        }),
      }),
    } as any;

    await expect(adminGuard.canActivate(nonAdminCtx)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('allows only active administrator/super_admin roles via RolesGuard', () => {
    const rolesGuard = new RolesGuard(reflector);
    const makeCtx = (
      admin: { role: AdminRole; isActive: boolean } | undefined,
    ) =>
      ({
        getHandler: () => SupportController.prototype.deleteSupportRequest,
        getClass: () => SupportController,
        switchToHttp: () => ({
          getRequest: () => ({ method: 'DELETE', admin }),
        }),
      }) as any;

    for (const allowedRole of [
      AdminRole.SUPER_ADMIN,
      AdminRole.ADMINISTRATOR,
    ]) {
      expect(
        rolesGuard.canActivate(makeCtx({ role: allowedRole, isActive: true })),
      ).toBe(true);
    }

    for (const deniedRole of [
      AdminRole.SECURITY_ANALYST,
      AdminRole.GOVERNANCE_OPERATOR,
      AdminRole.MODERATOR,
      AdminRole.AUDITOR,
    ]) {
      expect(() =>
        rolesGuard.canActivate(makeCtx({ role: deniedRole, isActive: true })),
      ).toThrow(ForbiddenException);
    }

    expect(() =>
      rolesGuard.canActivate(
        makeCtx({ role: AdminRole.ADMINISTRATOR, isActive: false }),
      ),
    ).toThrow(ForbiddenException);

    expect(() => rolesGuard.canActivate(makeCtx(undefined))).toThrow(
      ForbiddenException,
    );
  });

  it('delegates targeted deletion to SupportRequestService without calling cleanupExpiredSupportRequests', () => {
    const created = service.createSupportRequest({
      category: 'bug',
      contact: 'user@example.com',
      description: 'Delete me via controller.',
      release: 'v1.2.3',
    });

    const cleanupSpy = jest.spyOn(service, 'cleanupExpiredSupportRequests');
    const result = controller.deleteSupportRequest(created.id);

    expect(result).toEqual({
      deleted: true,
      id: created.id,
      reference: created.reference,
    });
    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(service.getSupportRequest(created.id)).toBeUndefined();
    expect(controller.deleteSupportRequest(created.id)).toEqual({
      deleted: false,
      id: created.id,
    });
  });

  it('never returns deleted: true when SupportRequestService.deleteSupportRequest throws', () => {
    jest
      .spyOn(service, 'deleteSupportRequest')
      .mockImplementationOnce(() => {
        throw new Error('persistence error');
      });

    expect(() => controller.deleteSupportRequest('req-1')).toThrow(
      'persistence error',
    );
  });
});

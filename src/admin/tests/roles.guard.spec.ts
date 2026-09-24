import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../guards/roles.guard';
import { AdminRole } from '../entities/admin.entity';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: jest.Mocked<Reflector>;

  const mockContext = (admin?: any) => {
    const handler = () => {};
    const cls = class {};
    return {
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({
        getRequest: () => ({ admin }),
      }),
    } as any;
  };

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as any;
    guard = new RolesGuard(reflector);
  });

  it('should allow access if no roles required', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    const result = guard.canActivate(mockContext({ role: AdminRole.AUDITOR }));

    expect(result).toBe(true);
  });

  it('should allow access if admin has sufficient role', () => {
    reflector.getAllAndOverride.mockReturnValue([AdminRole.MODERATOR]);

    const result = guard.canActivate(
      mockContext({ role: AdminRole.ADMINISTRATOR, isActive: true }),
    );

    expect(result).toBe(true);
  });

  it('should allow super_admin to access any endpoint', () => {
    reflector.getAllAndOverride.mockReturnValue([AdminRole.AUDITOR]);

    const result = guard.canActivate(
      mockContext({ role: AdminRole.SUPER_ADMIN, isActive: true }),
    );

    expect(result).toBe(true);
  });

  it('should deny access if admin has insufficient role', () => {
    reflector.getAllAndOverride.mockReturnValue([AdminRole.ADMINISTRATOR]);

    expect(() =>
      guard.canActivate(mockContext({ role: AdminRole.AUDITOR, isActive: true })),
    ).toThrow(ForbiddenException);
  });

  it('should deny access if admin is deactivated', () => {
    reflector.getAllAndOverride.mockReturnValue([AdminRole.AUDITOR]);

    expect(() =>
      guard.canActivate(mockContext({ role: AdminRole.AUDITOR, isActive: false })),
    ).toThrow(ForbiddenException);
  });

  it('should deny access if no admin in request', () => {
    reflector.getAllAndOverride.mockReturnValue([AdminRole.AUDITOR]);

    expect(() => guard.canActivate(mockContext(undefined))).toThrow(ForbiddenException);
  });

  it('should allow equal role level access', () => {
    reflector.getAllAndOverride.mockReturnValue([AdminRole.MODERATOR]);

    const result = guard.canActivate(
      mockContext({ role: AdminRole.MODERATOR, isActive: true }),
    );

    expect(result).toBe(true);
  });
});

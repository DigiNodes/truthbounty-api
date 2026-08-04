import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';

describe('RolesGuard', () => {
  const buildContext = (user: any) =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    }) as any;

  const buildReflector = (roles: string[] | undefined) =>
    ({
      getAllAndOverride: jest.fn().mockReturnValue(roles),
    }) as unknown as Reflector;

  it('allows the request when no roles are required', () => {
    const guard = new RolesGuard(buildReflector(undefined));
    expect(guard.canActivate(buildContext({ user: { role: 'contributor' } }))).toBe(true);
  });

  it('allows the request when the user role is in the required list', () => {
    const guard = new RolesGuard(buildReflector(['admin', 'moderator']));
    expect(guard.canActivate(buildContext({ user: { role: 'moderator' } }))).toBe(true);
  });

  it('denies the request when the user role is not in the required list', () => {
    const guard = new RolesGuard(buildReflector(['admin']));
    expect(() => guard.canActivate(buildContext({ user: { role: 'contributor' } }))).toThrow(
      ForbiddenException,
    );
  });

  it('denies the request when there is no authenticated user', () => {
    const guard = new RolesGuard(buildReflector(['admin']));
    expect(() => guard.canActivate(buildContext(null))).toThrow(ForbiddenException);
  });

  it('denies the request when the prisma user record is missing', () => {
    const guard = new RolesGuard(buildReflector(['admin']));
    expect(() => guard.canActivate(buildContext({ user: null }))).toThrow(ForbiddenException);
  });
});

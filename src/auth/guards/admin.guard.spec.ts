import { AdminGuard, ADMIN_ONLY_KEY } from './admin.guard';
import { Reflector } from '@nestjs/core';
import { ForbiddenException, ExecutionContext } from '@nestjs/common';

describe('AdminGuard', () => {
  let guard: AdminGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    // Set up admin wallets env
    process.env.ADMIN_WALLETS = '0xAdmin123,0xAdmin456';
    guard = new AdminGuard(reflector);
  });

  afterEach(() => {
    delete process.env.ADMIN_WALLETS;
  });

  function createMockContext(user?: any): ExecutionContext {
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          user: user || null,
          headers: {},
        }),
      }),
    } as unknown as ExecutionContext;
  }

  // ── Non-admin endpoints ──────────────────────────────────────────────────

  it('should allow access when endpoint is NOT marked as admin-only', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const context = createMockContext();

    expect(guard.canActivate(context)).toBe(true);
  });

  // ── Admin-only endpoints ─────────────────────────────────────────────────

  it('should deny access when user is not authenticated', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const context = createMockContext(null);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context)).toThrow('Authentication required for admin access');
  });

  it('should allow access for a user with admin role in JWT', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const context = createMockContext({
      address: '0xRegular',
      roles: ['admin'],
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access for a wallet in the admin list', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const context = createMockContext({
      address: '0xAdmin123',
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access for another wallet in the admin list (case insensitive)', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const context = createMockContext({
      address: '0xadmin456',
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should deny access for a non-admin wallet', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const context = createMockContext({
      address: '0xRegularUser',
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context)).toThrow('Admin privileges required');
  });

  it('should deny access for a user without admin role or admin wallet', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const context = createMockContext({
      address: '0xNobody',
      roles: ['user'],
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});

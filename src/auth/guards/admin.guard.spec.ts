import { AdminGuard } from './admin.guard';
import { Reflector } from '@nestjs/core';
import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import { AuthenticatedPrincipal } from '../types/authenticated-request';

describe('AdminGuard', () => {
  let guard: AdminGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    // Set up admin wallets env
    process.env.ADMIN_WALLETS = '0xAdmin123,0xAdmin456,user-id-admin-001';
    guard = new AdminGuard(reflector);
  });

  afterEach(() => {
    delete process.env.ADMIN_WALLETS;
  });

  /**
   * Create a mock execution context with a realistic Passport-style request.
   * The principal structure matches what JwtStrategy returns from AuthService.validateToken.
   */
  function createMockContext(
    principal?: AuthenticatedPrincipal | null,
    useLegacyField = false,
  ): ExecutionContext {
    const request: any = {
      headers: {},
    };

    // If useLegacyField is true, attach to request.use instead of request.user
    if (principal !== undefined && principal !== null) {
      if (useLegacyField) {
        request.use = principal;
      } else {
        request.user = principal;
      }
    }

    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }

  /**
   * Helper to create a realistic authenticated principal matching the
   * shape returned by AuthService.validateToken.
   */
  function createPrincipal(
    overrides?: Partial<AuthenticatedPrincipal>,
  ): AuthenticatedPrincipal {
    return {
      address: '0xRegularUser',
      userId: null,
      user: null,
      sub: undefined,
      jti: undefined,
      ...overrides,
    };
  }

  // ── Non-admin endpoints ──────────────────────────────────────────────────

  it('should allow access when endpoint is NOT marked as admin-only', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const context = createMockContext();

    expect(guard.canActivate(context)).toBe(true);
  });

  // ── Admin-only endpoints: Authentication failures ────────────────────────

  it('should deny access when user is not authenticated (no request.user)', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const context = createMockContext(null);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context)).toThrow(
      'Authentication required for admin access',
    );
  });

  it('should deny access when principal is missing address field', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const principal = createPrincipal({ address: undefined as any });
    const context = createMockContext(principal);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context)).toThrow(
      'Authentication required for admin access',
    );
  });

  // ── Admin-only endpoints: Role-based access (Passport-style request.user) ─

  it('should allow access for a user with admin role in principal.user.role', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const principal = createPrincipal({
      address: '0xRegular',
      userId: 'user-123',
      user: { id: 'user-123', role: 'admin' },
    });
    const context = createMockContext(principal);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access for a wallet in the admin allowlist', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const principal = createPrincipal({
      address: '0xAdmin123',
      userId: null,
      user: null,
    });
    const context = createMockContext(principal);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access for another wallet in the admin allowlist (case insensitive)', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const principal = createPrincipal({
      address: '0xadmin456',
    });
    const context = createMockContext(principal);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access for a userId in the admin allowlist', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const principal = createPrincipal({
      address: '0xSomeWallet',
      userId: 'user-id-admin-001',
      user: { id: 'user-id-admin-001', role: 'contributor' },
    });
    const context = createMockContext(principal);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should deny access for a non-admin wallet with no admin role', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const principal = createPrincipal({
      address: '0xRegularUser',
      user: { id: 'user-123', role: 'contributor' },
    });
    const context = createMockContext(principal);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context)).toThrow(
      'Admin privileges required',
    );
  });

  it('should deny access for a user with moderator role (not admin)', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const principal = createPrincipal({
      address: '0xModerator',
      user: { id: 'user-456', role: 'moderator' },
    });
    const context = createMockContext(principal);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should deny access when user field is null (wallet-only auth)', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const principal = createPrincipal({
      address: '0xUnknown',
      user: null,
    });
    const context = createMockContext(principal);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  // ── Legacy compatibility: request.use fallback ───────────────────────────

  it('should allow access when principal is in request.use (legacy fallback)', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const principal = createPrincipal({
      address: '0xAdmin123',
    });
    const context = createMockContext(principal, true); // use legacy field

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should prefer request.user over request.use when both are present', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const adminPrincipal = createPrincipal({
      address: '0xAdmin123',
    });
    const nonAdminPrincipal = createPrincipal({
      address: '0xRegular',
    });

    // Create a context with both fields, user should take precedence
    const request: any = {
      user: adminPrincipal,
      use: nonAdminPrincipal,
      headers: {},
    };

    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;

    // Should use request.user (admin) not request.use (non-admin)
    expect(guard.canActivate(context)).toBe(true);
  });

  // ── Edge cases: malformed principals ─────────────────────────────────────

  it('should deny access when principal has empty address string', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const principal = createPrincipal({
      address: '',
    });
    const context = createMockContext(principal);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context)).toThrow(
      'Authentication required for admin access',
    );
  });

  it('should deny access when principal.user exists but role is missing', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const principal = createPrincipal({
      address: '0xSomeUser',
      user: { id: 'user-123' } as any, // missing role field
    });
    const context = createMockContext(principal);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should deny access when principal.user.role is an unrecognized value', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const principal = createPrincipal({
      address: '0xSomeUser',
      user: { id: 'user-123', role: 'unknown-role' },
    });
    const context = createMockContext(principal);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should deny access when principal.user.role is empty string', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const principal = createPrincipal({
      address: '0xSomeUser',
      user: { id: 'user-123', role: '' },
    });
    const context = createMockContext(principal);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should deny access when request has malformed structure (not an object)', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    
    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => 'not-an-object' as any,
      }),
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  // ── Security: no privilege escalation from unverified fields ─────────────

  it('should NOT grant admin access from unverified request fields', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    
    // Attacker tries to inject admin fields outside the verified principal
    const request: any = {
      user: createPrincipal({
        address: '0xAttacker',
        user: { id: 'user-bad', role: 'contributor' },
      }),
      headers: {},
      // These should be ignored - only the verified principal matters
      isAdmin: true,
      adminRole: 'admin',
      roles: ['admin'],
    };

    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should NOT accept roles as an array (only principal.user.role string)', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    
    // Old buggy assumption: roles might be an array
    const principal: any = {
      address: '0xSomeUser',
      userId: 'user-123',
      user: { id: 'user-123', roles: ['admin'] }, // wrong shape
    };
    const context = createMockContext(principal);

    // Should fail because principal.user.role is undefined (not principal.user.roles)
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  // ── Wallet and userId allowlist behavior ─────────────────────────────────

  it('should match wallet addresses case-insensitively against allowlist', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    
    // Allowlist has '0xAdmin123', test with different casing
    const variations = ['0xADMIN123', '0xadmin123', '0xAdmin123'];
    
    variations.forEach(address => {
      const principal = createPrincipal({ address });
      const context = createMockContext(principal);
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  it('should match userId against allowlist when userId is present', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const principal = createPrincipal({
      address: '0xNonAdminWallet',
      userId: 'user-id-admin-001',
      user: null,
    });
    const context = createMockContext(principal);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should match sub field against allowlist when userId is missing', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const principal = createPrincipal({
      address: '0xNonAdminWallet',
      userId: null,
      sub: 'user-id-admin-001',
      user: null,
    });
    const context = createMockContext(principal);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should prioritize userId over sub when both are present in allowlist check', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    
    // userId is in allowlist, sub is not
    const principal = createPrincipal({
      address: '0xNonAdminWallet',
      userId: 'user-id-admin-001',
      sub: 'different-id-not-in-list',
      user: null,
    });
    const context = createMockContext(principal);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should deny when neither wallet, userId, nor role grant admin access', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const principal = createPrincipal({
      address: '0xRegularWallet',
      userId: 'regular-user-id',
      sub: 'regular-sub',
      user: { id: 'regular-user-id', role: 'contributor' },
    });
    const context = createMockContext(principal);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context)).toThrow('Admin privileges required');
  });

  // ── Environment configuration edge cases ─────────────────────────────────

  it('should work with empty ADMIN_WALLETS env (only role-based access)', () => {
    // Create a new guard with no wallet allowlist
    process.env.ADMIN_WALLETS = '';
    const guardNoList = new AdminGuard(reflector);
    
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    
    // Should still allow admin role
    const adminRolePrincipal = createPrincipal({
      address: '0xSomeWallet',
      user: { id: 'user-123', role: 'admin' },
    });
    const adminContext = createMockContext(adminRolePrincipal);
    expect(guardNoList.canActivate(adminContext)).toBe(true);
    
    // Should deny non-admin
    const regularPrincipal = createPrincipal({
      address: '0xSomeWallet',
      user: { id: 'user-456', role: 'contributor' },
    });
    const regularContext = createMockContext(regularPrincipal);
    expect(() => guardNoList.canActivate(regularContext)).toThrow(ForbiddenException);
  });

  it('should handle whitespace and empty entries in ADMIN_WALLETS', () => {
    process.env.ADMIN_WALLETS = ' 0xWallet1 , , 0xWallet2 ,  ';
    const guardWithWhitespace = new AdminGuard(reflector);
    
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    
    const wallet1Context = createMockContext(createPrincipal({ address: '0xWallet1' }));
    const wallet2Context = createMockContext(createPrincipal({ address: '0xWallet2' }));
    
    expect(guardWithWhitespace.canActivate(wallet1Context)).toBe(true);
    expect(guardWithWhitespace.canActivate(wallet2Context)).toBe(true);
  });
});

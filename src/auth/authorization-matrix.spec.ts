import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './guards/roles.guard';
import { APP_USER_ROLES, AppUserRole, isAppUserRole } from './authorization-matrix';

/**
 * Authorization Matrix regression tests (issue #458 — V2-BE-104).
 *
 * These tests are the machine-readable contract for the V2 API Authorization Matrix.
 * They must pass without skips to constitute CI evidence of correct RBAC behavior.
 *
 * Coverage:
 * 1. AppUserRole type-guard correctness
 * 2. Role set completeness
 * 3. Per-route role enforcement via RolesGuard
 * 4. Fail-closed invariants for all documented failure modes
 * 5. No unauthorized mutation path (no role escalation without Prisma user record)
 * 6. Boundary conditions: empty roles, single role, full role list
 */
describe('Authorization Matrix — AppUserRole type helpers', () => {
  it('APP_USER_ROLES contains exactly contributor, moderator, admin', () => {
    expect([...APP_USER_ROLES].sort()).toEqual(['admin', 'contributor', 'moderator']);
  });

  it('isAppUserRole returns true for all valid roles', () => {
    for (const role of APP_USER_ROLES) {
      expect(isAppUserRole(role)).toBe(true);
    }
  });

  it('isAppUserRole returns false for unknown strings', () => {
    expect(isAppUserRole('superuser')).toBe(false);
    expect(isAppUserRole('USER')).toBe(false);
    expect(isAppUserRole('ADMIN')).toBe(false);
    expect(isAppUserRole('')).toBe(false);
  });

  it('isAppUserRole returns false for non-string values', () => {
    expect(isAppUserRole(null)).toBe(false);
    expect(isAppUserRole(undefined)).toBe(false);
    expect(isAppUserRole(42)).toBe(false);
    expect(isAppUserRole({})).toBe(false);
  });
});

describe('Authorization Matrix — RolesGuard per-route enforcement', () => {
  /**
   * Build a minimal ExecutionContext carrying the given Prisma user role.
   */
  const ctx = (role: string | undefined | null) =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          user: role !== undefined && role !== null ? { user: { role } } : null,
        }),
      }),
    }) as any;

  const reflector = (roles: AppUserRole[] | undefined) =>
    ({
      getAllAndOverride: jest.fn().mockReturnValue(roles),
    }) as unknown as Reflector;

  // ─── Route table ──────────────────────────────────────────────────────────
  // Each entry represents a route-group from authorization-matrix.ts.

  const publicRouteGuard = () => new RolesGuard(reflector(undefined));

  const authnOnlyGuard = () =>
    // AUTHN-only routes don't use RolesGuard at all; this verifies pass-through.
    new RolesGuard(reflector(undefined));

  const moderatorOrAdminGuard = () => new RolesGuard(reflector(['moderator', 'admin']));

  const adminOnlyGuard = () => new RolesGuard(reflector(['admin']));

  // ─── Public routes — no role restriction ─────────────────────────────────

  describe('PUBLIC routes (no role restriction)', () => {
    it.each([
      ['contributor'],
      ['moderator'],
      ['admin'],
    ])('%s is allowed through with no required roles', (role) => {
      expect(publicRouteGuard().canActivate(ctx(role))).toBe(true);
    });

    it('unauthenticated caller is allowed through with no required roles', () => {
      // RolesGuard passes when requiredRoles is undefined — JWT guard handles auth
      expect(publicRouteGuard().canActivate(ctx(null))).toBe(true);
    });
  });

  // ─── AUTHN-only routes ────────────────────────────────────────────────────

  describe('AUTHN-only routes (no additional role check)', () => {
    it('any valid role passes through (RolesGuard is no-op here)', () => {
      for (const role of APP_USER_ROLES) {
        expect(authnOnlyGuard().canActivate(ctx(role))).toBe(true);
      }
    });
  });

  // ─── ROLE(moderator | admin) routes ──────────────────────────────────────
  // Applies to: dispute start-review/resolve/reject, governance activate/cancel,
  //             staking locks/withdrawals

  describe('ROLE(moderator | admin) routes', () => {
    it('moderator is allowed', () => {
      expect(moderatorOrAdminGuard().canActivate(ctx('moderator'))).toBe(true);
    });

    it('admin is allowed', () => {
      expect(moderatorOrAdminGuard().canActivate(ctx('admin'))).toBe(true);
    });

    it('contributor is denied — fail-closed', () => {
      expect(() => moderatorOrAdminGuard().canActivate(ctx('contributor'))).toThrow(
        ForbiddenException,
      );
    });

    it('unauthenticated is denied — fail-closed', () => {
      expect(() => moderatorOrAdminGuard().canActivate(ctx(null))).toThrow(
        ForbiddenException,
      );
    });

    it('undefined user is denied — fail-closed', () => {
      expect(() => moderatorOrAdminGuard().canActivate(ctx(undefined))).toThrow(
        ForbiddenException,
      );
    });
  });

  // ─── ROLE(admin) routes ───────────────────────────────────────────────────
  // Applies to: rewards write, staking reconcile, governance execute

  describe('ROLE(admin) routes', () => {
    it('admin is allowed', () => {
      expect(adminOnlyGuard().canActivate(ctx('admin'))).toBe(true);
    });

    it('moderator is denied — fail-closed', () => {
      expect(() => adminOnlyGuard().canActivate(ctx('moderator'))).toThrow(
        ForbiddenException,
      );
    });

    it('contributor is denied — fail-closed', () => {
      expect(() => adminOnlyGuard().canActivate(ctx('contributor'))).toThrow(
        ForbiddenException,
      );
    });

    it('unauthenticated is denied — fail-closed', () => {
      expect(() => adminOnlyGuard().canActivate(ctx(null))).toThrow(
        ForbiddenException,
      );
    });

    it('unknown role string is denied — fail-closed', () => {
      expect(() => adminOnlyGuard().canActivate(ctx('superadmin'))).toThrow(
        ForbiddenException,
      );
    });
  });

  // ─── Fail-closed invariants (documented failure modes) ───────────────────

  describe('Fail-closed invariants', () => {
    it('missing Prisma user record (user.user = null) is denied on any role-restricted route', () => {
      const guard = new RolesGuard(reflector(['admin']));
      const context = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            // JWT validated but no linked Prisma user
            user: { address: '0xabc', userId: 'uid-1', user: null },
          }),
        }),
      } as any;
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('role field missing from Prisma user record is denied on any role-restricted route', () => {
      const guard = new RolesGuard(reflector(['moderator', 'admin']));
      const context = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            user: { user: {} }, // role field absent
          }),
        }),
      } as any;
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('role field with empty string is denied', () => {
      const guard = new RolesGuard(reflector(['admin']));
      expect(() => guard.canActivate(ctx(''))).toThrow(ForbiddenException);
    });

    it('guard never silently permits — always throws or returns true', () => {
      // Enumerate all failure cases and confirm they throw, never return false
      const guard = new RolesGuard(reflector(['admin']));
      const failureCases = [null, undefined, 'contributor', 'moderator', '', 'root'];
      for (const role of failureCases) {
        expect(() => guard.canActivate(ctx(role as any))).toThrow(ForbiddenException);
      }
    });
  });

  // ─── No role escalation without DB record ────────────────────────────────

  describe('No unauthorized mutation path', () => {
    it('JWT sub claim alone does NOT grant elevated access (Prisma user.role required)', () => {
      // A JWT with sub: '0xadmin' must not bypass role checks without a Prisma record
      const guard = new RolesGuard(reflector(['admin']));
      const context = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            user: {
              sub: '0xadmin',
              address: '0xadmin',
              userId: 'admin-uid',
              user: null, // no Prisma record
            },
          }),
        }),
      } as any;
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('roles array in JWT payload alone does NOT grant access (Prisma user.role required)', () => {
      // Legacy JWT with a `roles` array must not bypass the Prisma-based RolesGuard
      const guard = new RolesGuard(reflector(['admin']));
      const context = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            user: {
              roles: ['admin'],   // JWT claim — NOT the Prisma user.role
              user: null,         // no Prisma User record
            },
          }),
        }),
      } as any;
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  // ─── Boundary conditions ──────────────────────────────────────────────────

  describe('Boundary conditions', () => {
    it('empty required-roles array behaves identically to no restriction (allow all)', () => {
      const guard = new RolesGuard(reflector([]));
      for (const role of [...APP_USER_ROLES, undefined]) {
        expect(guard.canActivate(ctx(role as any))).toBe(true);
      }
    });

    it('all three valid roles pass a full-list required-roles check', () => {
      const guard = new RolesGuard(reflector(['contributor', 'moderator', 'admin']));
      for (const role of APP_USER_ROLES) {
        expect(guard.canActivate(ctx(role))).toBe(true);
      }
    });

    it('ForbiddenException message includes required role names', () => {
      const guard = new RolesGuard(reflector(['admin']));
      try {
        guard.canActivate(ctx('contributor'));
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).message).toContain('admin');
      }
    });
  });
});

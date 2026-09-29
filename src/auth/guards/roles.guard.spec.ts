import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY, AppUserRole } from '../decorators/roles.decorator';

/**
 * Unit tests for auth/guards/RolesGuard (app-user plane).
 *
 * Covers all documented failure modes from the V2 API Authorization Matrix:
 * - No roles required         → allow
 * - Matching role present     → allow
 * - Role insufficient         → ForbiddenException (fail-closed)
 * - No authenticated user     → ForbiddenException (fail-closed)
 * - Prisma user record null   → ForbiddenException (fail-closed)
 * - Role field missing        → ForbiddenException (fail-closed)
 * - Unknown role value        → ForbiddenException (fail-closed)
 * - Multi-role list: one match → allow
 * - Multi-role list: no match → ForbiddenException
 */
describe('RolesGuard (app-user plane)', () => {
  let guard: RolesGuard;

  const buildContext = (user: any) =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    }) as any;

  const buildReflector = (roles: AppUserRole[] | undefined) =>
    ({
      getAllAndOverride: jest.fn().mockReturnValue(roles),
    }) as unknown as Reflector;

  // ── No role restriction ──────────────────────────────────────────────────

  it('allows the request when no roles are required', () => {
    guard = new RolesGuard(buildReflector(undefined));
    expect(guard.canActivate(buildContext({ user: { role: 'contributor' } }))).toBe(true);
  });

  it('allows the request when roles array is empty', () => {
    guard = new RolesGuard(buildReflector([]));
    expect(guard.canActivate(buildContext({ user: { role: 'contributor' } }))).toBe(true);
  });

  // ── Successful authorization ─────────────────────────────────────────────

  it('allows when user role exactly matches the single required role', () => {
    guard = new RolesGuard(buildReflector(['admin']));
    expect(guard.canActivate(buildContext({ user: { role: 'admin' } }))).toBe(true);
  });

  it('allows when user role is in a multi-role list — moderator match', () => {
    guard = new RolesGuard(buildReflector(['moderator', 'admin']));
    expect(guard.canActivate(buildContext({ user: { role: 'moderator' } }))).toBe(true);
  });

  it('allows when user role is in a multi-role list — admin match', () => {
    guard = new RolesGuard(buildReflector(['moderator', 'admin']));
    expect(guard.canActivate(buildContext({ user: { role: 'admin' } }))).toBe(true);
  });

  it('allows contributor when contributor is the only required role', () => {
    guard = new RolesGuard(buildReflector(['contributor']));
    expect(guard.canActivate(buildContext({ user: { role: 'contributor' } }))).toBe(true);
  });

  // ── Failure-closed: insufficient role ────────────────────────────────────

  it('throws ForbiddenException when contributor tries to access a moderator route', () => {
    guard = new RolesGuard(buildReflector(['moderator', 'admin']));
    expect(() => guard.canActivate(buildContext({ user: { role: 'contributor' } }))).toThrow(
      ForbiddenException,
    );
  });

  it('throws ForbiddenException when moderator tries to access an admin-only route', () => {
    guard = new RolesGuard(buildReflector(['admin']));
    expect(() => guard.canActivate(buildContext({ user: { role: 'moderator' } }))).toThrow(
      ForbiddenException,
    );
  });

  it('throws ForbiddenException with a descriptive message', () => {
    guard = new RolesGuard(buildReflector(['admin']));
    expect(() => guard.canActivate(buildContext({ user: { role: 'contributor' } }))).toThrow(
      'Access denied. Required role(s): admin',
    );
  });

  // ── Failure-closed: missing/null identity ────────────────────────────────

  it('throws ForbiddenException when request.user is null', () => {
    guard = new RolesGuard(buildReflector(['admin']));
    expect(() => guard.canActivate(buildContext(null))).toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when request.user is undefined', () => {
    guard = new RolesGuard(buildReflector(['admin']));
    expect(() => guard.canActivate(buildContext(undefined))).toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when Prisma user record (user.user) is null', () => {
    guard = new RolesGuard(buildReflector(['admin']));
    expect(() => guard.canActivate(buildContext({ user: null }))).toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when Prisma user record is missing (user.user undefined)', () => {
    guard = new RolesGuard(buildReflector(['admin']));
    // JWT validated but no linked Prisma User record
    expect(() => guard.canActivate(buildContext({ address: '0xabc', user: undefined }))).toThrow(
      ForbiddenException,
    );
  });

  it('throws ForbiddenException when role field is missing from Prisma user record', () => {
    guard = new RolesGuard(buildReflector(['admin']));
    expect(() => guard.canActivate(buildContext({ user: {} }))).toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when role is an unknown/invalid value', () => {
    guard = new RolesGuard(buildReflector(['admin']));
    // An unrecognized role must never grant elevated access — fail closed.
    expect(() => guard.canActivate(buildContext({ user: { role: 'superuser' } }))).toThrow(
      ForbiddenException,
    );
  });

  // ── Multi-role list: all miss ─────────────────────────────────────────────

  it('throws ForbiddenException when user role matches none of multiple required roles', () => {
    guard = new RolesGuard(buildReflector(['moderator', 'admin']));
    expect(() =>
      guard.canActivate(buildContext({ user: { role: 'contributor' } })),
    ).toThrow(ForbiddenException);
  });

  // ── No role escalation without Prisma record ─────────────────────────────

  it('does NOT grant access based on JWT payload alone — Prisma user.role is required', () => {
    // request.user has address/userId from JWT but no linked Prisma `user` record
    guard = new RolesGuard(buildReflector(['admin']));
    expect(() =>
      guard.canActivate(
        buildContext({ address: '0xadmin', userId: 'uid-1', user: null }),
      ),
    ).toThrow(ForbiddenException);
  });
});

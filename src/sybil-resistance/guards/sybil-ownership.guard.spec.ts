import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { SybilOwnershipGuard } from './sybil-ownership.guard';

describe('SybilOwnershipGuard', () => {
  let guard: SybilOwnershipGuard;

  beforeEach(() => {
    guard = new SybilOwnershipGuard();
  });

  const createMockContext = (
    reqUser: any,
    params: Record<string, string> = {},
    body: Record<string, any> = {},
  ): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          user: reqUser,
          params,
          body,
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  describe('Unauthenticated callers', () => {
    it('throws UnauthorizedException when req.user is null or undefined', () => {
      const ctx = createMockContext(null, { userId: 'usr-1' });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when req.user is empty object without principal identity', () => {
      const ctx = createMockContext({}, { userId: 'usr-1' });
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });

  describe('Authenticated callers — Ownership & Role enforcement', () => {
    it('allows owner when caller userId matches params.userId', () => {
      const ctx = createMockContext(
        { address: '0x123', userId: 'usr-1', user: { role: 'contributor' } },
        { userId: 'usr-1' },
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('allows owner when caller user.id matches params.userId', () => {
      const ctx = createMockContext(
        { address: '0x123', user: { id: 'usr-1', role: 'contributor' } },
        { userId: 'usr-1' },
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('allows owner when target ID is in params.id', () => {
      const ctx = createMockContext(
        { address: '0x123', userId: 'usr-1', user: { role: 'contributor' } },
        { id: 'usr-1' },
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('allows owner when target ID is in body.userId', () => {
      const ctx = createMockContext(
        { address: '0x123', userId: 'usr-1', user: { role: 'contributor' } },
        {},
        { userId: 'usr-1' },
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('denies access when caller is a different user (non-owner) with contributor role', () => {
      const ctx = createMockContext(
        { address: '0x123', userId: 'usr-attacker', user: { role: 'contributor' } },
        { userId: 'usr-victim' },
      );
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('allows privileged moderator to access another user\'s data', () => {
      const ctx = createMockContext(
        { address: '0xmod', userId: 'usr-mod', user: { role: 'moderator' } },
        { userId: 'usr-target' },
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('allows privileged admin to access another user\'s data', () => {
      const ctx = createMockContext(
        { address: '0xadmin', userId: 'usr-admin', user: { role: 'admin' } },
        { userId: 'usr-target' },
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('passes through when targetUserId is missing or empty so controller validates param', () => {
      const ctx = createMockContext(
        { address: '0x123', userId: 'usr-1', user: { role: 'contributor' } },
        { userId: '' },
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });
});

import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { WorldcoinVerificationGuard } from './worldcoin-verification.guard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(
  user: unknown,
  bodyUserId?: string,
): ExecutionContext {
  const request: Record<string, unknown> = {
    user,
    body: bodyUserId !== undefined ? { userId: bodyUserId } : {},
  };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorldcoinVerificationGuard', () => {
  let guard: WorldcoinVerificationGuard;

  beforeEach(() => {
    guard = new WorldcoinVerificationGuard();
  });

  // =========================================================================
  // No principal (unauthenticated)
  // =========================================================================

  describe('unauthenticated requests', () => {
    it('throws UnauthorizedException when request.user is undefined', () => {
      const ctx = makeContext(undefined, 'user-1');
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when request.user is null', () => {
      const ctx = makeContext(null, 'user-1');
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when request.user has no sub or userId', () => {
      const ctx = makeContext({}, 'user-1');
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when request.user is a non-object (string)', () => {
      const ctx = makeContext('bad-user', 'user-1');
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });

  // =========================================================================
  // IDOR prevention — userId mismatch
  // =========================================================================

  describe('IDOR prevention', () => {
    it('throws ForbiddenException when body.userId does not match principal.sub', () => {
      const ctx = makeContext({ sub: 'user-A' }, 'user-B');
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when body.userId does not match principal.userId', () => {
      const ctx = makeContext({ userId: 'user-A' }, 'user-B');
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('prefers principal.sub over principal.userId when both present', () => {
      // sub mismatch, userId match → should reject based on sub
      const ctx = makeContext({ sub: 'user-X', userId: 'user-1' }, 'user-1');
      // 'user-X' (sub) !== 'user-1' (body) → ForbiddenException
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });
  });

  // =========================================================================
  // Authorized — userId matches principal
  // =========================================================================

  describe('authorized requests', () => {
    it('returns true when body.userId matches principal.sub', () => {
      const ctx = makeContext({ sub: 'user-1' }, 'user-1');
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('returns true when body.userId matches principal.userId (no sub)', () => {
      const ctx = makeContext({ userId: 'user-1' }, 'user-1');
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('returns true when body has no userId (body validation left to class-validator)', () => {
      const ctx = makeContext({ sub: 'user-1' });
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });
});

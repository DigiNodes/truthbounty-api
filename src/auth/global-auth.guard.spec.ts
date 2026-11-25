import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GlobalAuthGuard } from './global-auth.guard';

describe('GlobalAuthGuard', () => {
let guard: GlobalAuthGuard;

beforeEach(() => {
guard = new GlobalAuthGuard(new Reflector());
});

it('should rethrow the original Error when authentication fails', () => {
const originalError = new Error('JWT authentication failed');

expect(() => {
guard.handleRequest(originalError, false, undefined);
}).toThrow(originalError);
});

it('should throw UnauthorizedException for a non-Error authentication error', () => {
expect(() =>
guard.handleRequest('authentication failed', false, undefined),
).toThrow(UnauthorizedException);
});

it('should reject a missing user', () => {
expect(() =>
guard.handleRequest(null, null, undefined),
).toThrow(ForbiddenException);
});

it('should reject a false user', () => {
expect(() =>
guard.handleRequest(null, false, undefined),
).toThrow(ForbiddenException);
});

it('should reject a malformed user without an address', () => {
expect(() =>
guard.handleRequest(null, { id: '123' }, undefined),
).toThrow(ForbiddenException);
});

it('should accept a valid authenticated principal', () => {
const user = { address: '0x123', userId: '123' };

expect(guard.handleRequest(null, user, undefined)).toBe(user);
});
});

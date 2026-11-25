/**
 * AuthorizationPolicyService — capability token replay protection tests.
 *
 * These tests verify that the HMAC-based capability path
 * (AuthorizationPolicyService.issueCapabilityToken / useCapabilityToken)
 * has the same single-use, fail-closed guarantees as the JWT-based path
 * (TokenService.issueCapabilityToken / validateAndConsumeCapabilityToken).
 *
 * Replay semantics contract (both paths):
 *   - A nonce can be consumed at most once, including under concurrency.
 *   - Nonce claiming is atomic (Lua SET NX EX in AuthorizationPolicyService,
 *     Lua GET==ARGV→DEL in TokenService).
 *   - Redis unavailability always throws (fail closed); it never silently
 *     authorises a capability operation.
 *   - A mismatched binding does not consume any nonce.
 */

import { ConfigService } from '@nestjs/config';
import {
  AuthorizationPolicyService,
  CapabilityIssueRequest,
  CapabilityUseRequest,
  CapabilityTokenError,
  ResourceType,
  ActionType,
} from './authorization-policy.service';
import { RedisService } from '../redis/redis.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SIGNING_KEY = 'test-signing-key-at-least-32-characters-long';

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  return {
    get: jest.fn((key: string) => {
      const defaults: Record<string, string> = {
        CAPABILITY_TOKEN_SIGNING_KEY: SIGNING_KEY,
        CHAIN_ID: '10',
        RELEASE_ID: 'release-1',
        DEPLOYMENT_ID: 'deployment-1',
        ARTIFACT_CHECKSUM: 'artifact-1',
        ...overrides,
      };
      return defaults[key] ?? undefined;
    }),
  } as unknown as ConfigService;
}

/** In-memory Redis stand-in that tracks SET-NX calls and simulates atomicity. */
class FakeRedis {
  private store = new Map<string, string>();
  public evalCalls: Array<{ script: string; key: string; args: string[] }> = [];
  public getCalls: string[] = [];

  // Simulates the Lua SET NX EX script used in useCapabilityToken.
  // Returns 1 on first call for a key, 0 on subsequent calls (nonce already claimed).
  async eval(
    script: string,
    _numKeys: number,
    key: string,
    ...args: string[]
  ): Promise<unknown> {
    this.evalCalls.push({ script, key, args });
    // SET NX path (useCapabilityToken nonce claim)
    if (script.includes("'NX'")) {
      if (this.store.has(key)) return 0;
      this.store.set(key, args[0] ?? '1');
      return 1;
    }
    throw new Error(`Unexpected Lua script in test: ${script.slice(0, 60)}`);
  }

  async get(key: string): Promise<string | null> {
    this.getCalls.push(key);
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, _ttl?: number): Promise<boolean> {
    this.store.set(key, value);
    return true;
  }

  reset(): void {
    this.store.clear();
    this.evalCalls = [];
    this.getCalls = [];
  }
}

/** Redis that always throws from eval (simulates connection failure). */
class UnavailableRedis {
  async eval(): Promise<never> {
    throw new Error('Redis unavailable (Fail Closed)');
  }
  async get(): Promise<string | null> { return null; }
  async set(): Promise<boolean> { return false; }
}

function makeService(redis: FakeRedis | UnavailableRedis): AuthorizationPolicyService {
  return new AuthorizationPolicyService(
    makeConfig(),
    redis as unknown as RedisService,
  );
}

const BASE_REQUEST: CapabilityIssueRequest = {
  aud: 'claims-service',
  sub: 'user-abc',
  cap: 'claim:update',
  resource: ResourceType.CLAIM,
  action: ActionType.UPDATE,
  chain: '10',
  release: 'release-1',
  deployment: 'deployment-1',
  artifact: 'artifact-1',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthorizationPolicyService — capability token replay protection', () => {
  let redis: FakeRedis;
  let service: AuthorizationPolicyService;

  beforeEach(() => {
    redis = new FakeRedis();
    service = makeService(redis);
  });

  // ── Issuance ──────────────────────────────────────────────────────────────

  describe('issueCapabilityToken', () => {
    it('issues a token with a unique nonce and valid signature', async () => {
      const token = await service.issueCapabilityToken(BASE_REQUEST);
      expect(token.claims.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(typeof token.signature).toBe('string');
      expect(token.signature.length).toBeGreaterThan(0);
      expect(token.claims.aud).toBe(BASE_REQUEST.aud);
      expect(token.claims.sub).toBe(BASE_REQUEST.sub);
      expect(token.claims.cap).toBe(BASE_REQUEST.cap);
    });

    it('rejects issuance with missing required fields', async () => {
      await expect(
        service.issueCapabilityToken({ ...BASE_REQUEST, aud: '' }),
      ).rejects.toThrow(CapabilityTokenError);
      await expect(
        service.issueCapabilityToken({ ...BASE_REQUEST, sub: '' }),
      ).rejects.toThrow(CapabilityTokenError);
    });

    it('rejects issuance with unknown resource type', async () => {
      await expect(
        service.issueCapabilityToken({
          ...BASE_REQUEST,
          resource: 'nonexistent' as ResourceType,
        }),
      ).rejects.toThrow(CapabilityTokenError);
    });
  });

  // ── Single-use consumption ────────────────────────────────────────────────

  describe('useCapabilityToken — single-use semantics', () => {
    async function issueAndBuildRequest(): Promise<CapabilityUseRequest> {
      const token = await service.issueCapabilityToken(BASE_REQUEST);
      return {
        token,
        aud: BASE_REQUEST.aud,
        sub: BASE_REQUEST.sub,
        cap: BASE_REQUEST.cap,
        resource: BASE_REQUEST.resource,
        action: BASE_REQUEST.action,
        chain: BASE_REQUEST.chain,
        release: BASE_REQUEST.release,
        deployment: BASE_REQUEST.deployment,
        artifact: BASE_REQUEST.artifact,
      };
    }

    it('succeeds on the first use', async () => {
      const req = await issueAndBuildRequest();
      await expect(service.useCapabilityToken(req)).resolves.toBeUndefined();
    });

    it('rejects sequential replay after successful first use', async () => {
      const req = await issueAndBuildRequest();
      await service.useCapabilityToken(req);
      await expect(service.useCapabilityToken(req)).rejects.toThrow(
        'replay',
      );
    });

    it('concurrent requests: exactly one wins and one is rejected', async () => {
      const req = await issueAndBuildRequest();
      // Fire both attempts without awaiting between them.
      const [r1, r2] = await Promise.allSettled([
        service.useCapabilityToken(req),
        service.useCapabilityToken(req),
      ]);
      const successes = [r1, r2].filter((r) => r.status === 'fulfilled');
      const failures = [r1, r2].filter((r) => r.status === 'rejected');
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      const err = (failures[0] as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(CapabilityTokenError);
      expect((err as CapabilityTokenError).code).toBe('replay');
    });

    it('nonce claiming uses a single atomic eval (SET NX EX) — no GET-then-SET', async () => {
      const req = await issueAndBuildRequest();
      redis.reset();
      await service.useCapabilityToken(req);
      // Should have exactly one eval call for the nonce claim.
      const nonceClaims = redis.evalCalls.filter((c) => c.script.includes("'NX'"));
      expect(nonceClaims).toHaveLength(1);
      // The nonce key should not appear in GET calls (would indicate a non-atomic read).
      const nonceKey = `capability:nonce:${req.token.claims.nonce}`;
      expect(redis.getCalls).not.toContain(nonceKey);
    });
  });

  // ── Binding verification ──────────────────────────────────────────────────

  describe('useCapabilityToken — binding verification without consuming an unrelated nonce', () => {
    it('rejects wrong audience without touching the nonce', async () => {
      const token = await service.issueCapabilityToken(BASE_REQUEST);
      redis.reset();
      await expect(
        service.useCapabilityToken({
          token,
          aud: 'wrong-audience',
          sub: BASE_REQUEST.sub,
          cap: BASE_REQUEST.cap,
          resource: BASE_REQUEST.resource,
          action: BASE_REQUEST.action,
          chain: BASE_REQUEST.chain,
          release: BASE_REQUEST.release,
          deployment: BASE_REQUEST.deployment,
          artifact: BASE_REQUEST.artifact,
        }),
      ).rejects.toThrow(CapabilityTokenError);
      expect(redis.evalCalls).toHaveLength(0);
    });

    it('rejects wrong subject without touching the nonce', async () => {
      const token = await service.issueCapabilityToken(BASE_REQUEST);
      redis.reset();
      await expect(
        service.useCapabilityToken({
          token,
          aud: BASE_REQUEST.aud,
          sub: 'wrong-subject',
          cap: BASE_REQUEST.cap,
          resource: BASE_REQUEST.resource,
          action: BASE_REQUEST.action,
          chain: BASE_REQUEST.chain,
          release: BASE_REQUEST.release,
          deployment: BASE_REQUEST.deployment,
          artifact: BASE_REQUEST.artifact,
        }),
      ).rejects.toThrow(CapabilityTokenError);
      expect(redis.evalCalls).toHaveLength(0);
    });

    it('rejects wrong capability without touching the nonce', async () => {
      const token = await service.issueCapabilityToken(BASE_REQUEST);
      redis.reset();
      await expect(
        service.useCapabilityToken({
          token,
          aud: BASE_REQUEST.aud,
          sub: BASE_REQUEST.sub,
          cap: 'wrong-cap',
          resource: BASE_REQUEST.resource,
          action: BASE_REQUEST.action,
          chain: BASE_REQUEST.chain,
          release: BASE_REQUEST.release,
          deployment: BASE_REQUEST.deployment,
          artifact: BASE_REQUEST.artifact,
        }),
      ).rejects.toThrow(CapabilityTokenError);
      expect(redis.evalCalls).toHaveLength(0);
    });

    it('rejects wrong chain without touching the nonce', async () => {
      const token = await service.issueCapabilityToken(BASE_REQUEST);
      redis.reset();
      await expect(
        service.useCapabilityToken({
          token,
          aud: BASE_REQUEST.aud,
          sub: BASE_REQUEST.sub,
          cap: BASE_REQUEST.cap,
          resource: BASE_REQUEST.resource,
          action: BASE_REQUEST.action,
          chain: 'wrong-chain',
          release: BASE_REQUEST.release,
          deployment: BASE_REQUEST.deployment,
          artifact: BASE_REQUEST.artifact,
        }),
      ).rejects.toThrow(CapabilityTokenError);
      expect(redis.evalCalls).toHaveLength(0);
    });

    it('rejects a tampered signature without touching the nonce', async () => {
      const token = await service.issueCapabilityToken(BASE_REQUEST);
      redis.reset();
      await expect(
        service.useCapabilityToken({
          token: { claims: token.claims, signature: 'deadbeef'.repeat(8) },
          aud: BASE_REQUEST.aud,
          sub: BASE_REQUEST.sub,
          cap: BASE_REQUEST.cap,
          resource: BASE_REQUEST.resource,
          action: BASE_REQUEST.action,
          chain: BASE_REQUEST.chain,
          release: BASE_REQUEST.release,
          deployment: BASE_REQUEST.deployment,
          artifact: BASE_REQUEST.artifact,
        }),
      ).rejects.toThrow(CapabilityTokenError);
      expect(redis.evalCalls).toHaveLength(0);
    });

    it('rejects an expired token without touching the nonce', async () => {
      const token = await service.issueCapabilityToken(BASE_REQUEST);
      // Backdate the claims to make them expired.
      const expiredClaims = {
        ...token.claims,
        iat: Math.floor(Date.now() / 1000) - 400,
        exp: Math.floor(Date.now() / 1000) - 100,
      };
      // Re-sign with the same key.
      const { createHmac } = await import('node:crypto');
      const canonical = JSON.stringify({
        ver: expiredClaims.ver,
        aud: expiredClaims.aud,
        sub: expiredClaims.sub,
        cap: expiredClaims.cap,
        resource: expiredClaims.resource,
        resourceId: expiredClaims.resourceId ?? null,
        action: expiredClaims.action,
        nonce: expiredClaims.nonce,
        iat: expiredClaims.iat,
        exp: expiredClaims.exp,
        chain: expiredClaims.chain,
        release: expiredClaims.release,
        deployment: expiredClaims.deployment,
        artifact: expiredClaims.artifact,
      });
      const expiredSig = createHmac('sha256', SIGNING_KEY).update(canonical).digest('hex');
      redis.reset();
      await expect(
        service.useCapabilityToken({
          token: { claims: expiredClaims, signature: expiredSig },
          aud: BASE_REQUEST.aud,
          sub: BASE_REQUEST.sub,
          cap: BASE_REQUEST.cap,
          resource: BASE_REQUEST.resource,
          action: BASE_REQUEST.action,
          chain: BASE_REQUEST.chain,
          release: BASE_REQUEST.release,
          deployment: BASE_REQUEST.deployment,
          artifact: BASE_REQUEST.artifact,
        }),
      ).rejects.toThrow(CapabilityTokenError);
      expect(redis.evalCalls).toHaveLength(0);
    });

    it('rejects a malformed token without touching the nonce', async () => {
      redis.reset();
      await expect(
        service.useCapabilityToken({
          token: null as never,
          aud: BASE_REQUEST.aud,
          sub: BASE_REQUEST.sub,
          cap: BASE_REQUEST.cap,
          resource: BASE_REQUEST.resource,
          action: BASE_REQUEST.action,
          chain: BASE_REQUEST.chain,
          release: BASE_REQUEST.release,
          deployment: BASE_REQUEST.deployment,
          artifact: BASE_REQUEST.artifact,
        }),
      ).rejects.toThrow(CapabilityTokenError);
      expect(redis.evalCalls).toHaveLength(0);
    });
  });

  // ── Fail-closed on Redis unavailability ───────────────────────────────────

  describe('useCapabilityToken — fail closed when Redis is unavailable', () => {
    it('throws when the nonce eval throws (Redis down)', async () => {
      const unavailableService = makeService(new UnavailableRedis());
      const token = await service.issueCapabilityToken(BASE_REQUEST);
      await expect(
        unavailableService.useCapabilityToken({
          token,
          aud: BASE_REQUEST.aud,
          sub: BASE_REQUEST.sub,
          cap: BASE_REQUEST.cap,
          resource: BASE_REQUEST.resource,
          action: BASE_REQUEST.action,
          chain: BASE_REQUEST.chain,
          release: BASE_REQUEST.release,
          deployment: BASE_REQUEST.deployment,
          artifact: BASE_REQUEST.artifact,
        }),
      ).rejects.toThrow(CapabilityTokenError);
    });
  });

  // ── Revoked subject ───────────────────────────────────────────────────────

  describe('useCapabilityToken — revoked subject is rejected before nonce is consumed', () => {
    it('rejects a revoked subject without consuming the nonce', async () => {
      // Prime revocation entry.
      await redis.set('capability:revoked:sub:user-abc', '1');
      const token = await service.issueCapabilityToken(BASE_REQUEST);
      redis.evalCalls = [];
      await expect(
        service.useCapabilityToken({
          token,
          aud: BASE_REQUEST.aud,
          sub: BASE_REQUEST.sub,
          cap: BASE_REQUEST.cap,
          resource: BASE_REQUEST.resource,
          action: BASE_REQUEST.action,
          chain: BASE_REQUEST.chain,
          release: BASE_REQUEST.release,
          deployment: BASE_REQUEST.deployment,
          artifact: BASE_REQUEST.artifact,
        }),
      ).rejects.toThrow(CapabilityTokenError);
      // Nonce must not have been consumed.
      expect(redis.evalCalls).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-path parity documentation test
// ---------------------------------------------------------------------------

describe('Capability token path parity (HMAC vs JWT)', () => {
  /**
   * Both capability token paths must have equivalent single-use guarantees:
   *
   * AuthorizationPolicyService (HMAC-SHA256 signatures, Lua SET NX EX nonce):
   *   - Nonce is claimed once atomically; a second claim returns 0.
   *   - Redis unavailability throws (fail closed via redisService.eval).
   *
   * TokenService (JWT signatures, Lua GET==ARGV→DEL nonce):
   *   - Nonce is consumed once atomically; a second DEL returns 0.
   *   - Redis unavailability throws (fail closed via redisService.eval).
   *
   * The two paths are complementary:
   *   - SET NX is better when the nonce is not pre-stored (claim-on-use).
   *   - GET==ARGV→DEL is better when the issuer pre-stores a binding that
   *     the validator must verify before consuming (pre-stored binding check).
   *
   * Neither path falls back to a non-atomic GET-then-write sequence.
   * Neither path silently authorises on Redis unavailability.
   */
  it('documents that both capability paths use atomic Redis operations and fail closed', () => {
    // This test is a living specification comment verified by the other suites.
    // It passes as long as:
    //   1. AuthorizationPolicyService.useCapabilityToken tests above pass.
    //   2. TokenService.validateAndConsumeCapabilityToken tests in
    //      token.service.spec.ts pass.
    expect(true).toBe(true);
  });
});

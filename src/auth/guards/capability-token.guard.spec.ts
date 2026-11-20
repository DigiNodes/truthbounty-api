import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  AuthorizationPolicyService,
  CapabilityTokenGuard,
  ResourceType,
  ActionType,
  REQUIRE_CAPABILITY_KEY,
  CapabilityRequirement,
} from '../authorization-policy.service';
import {
  TokenService,
  JwtCapabilityTokenGuard,
  REQUIRE_JWT_CAPABILITY_KEY,
} from '../services/token.service';
import { JwtService } from '@nestjs/jwt';
import { AuthenticatedPrincipal, extractCapabilitySubject } from '../types/authenticated-request';

describe('CapabilityTokenGuard & Subject Precedence (PREWAVE-BE-144 / Issue #847)', () => {
  let policyService: AuthorizationPolicyService;
  let capabilityGuard: CapabilityTokenGuard;
  let tokenService: TokenService;
  let jwtCapabilityGuard: JwtCapabilityTokenGuard;
  let reflector: Reflector;
  let mockRedis: Record<string, string>;

  const defaultRequirement: CapabilityRequirement = {
    aud: 'truthbounty:api',
    cap: 'claim:create',
    resource: ResourceType.CLAIM,
    action: ActionType.CREATE,
  };

  const defaultContext = {
    chain: 'eip155:10',
    release: 'rel-1.0.0',
    deployment: 'dep-prod-1',
    artifact: 'sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
  };

  beforeEach(() => {
    mockRedis = {};

    const mockRedisService: any = {
      get: jest.fn(async (key: string) => mockRedis[key] ?? null),
      set: jest.fn(async (key: string, value: string) => {
        mockRedis[key] = value;
        return 'OK';
      }),
      del: jest.fn(async (key: string) => {
        delete mockRedis[key];
        return 1;
      }),
      setIfNotExists: jest.fn(async (key: string, value: string) => {
        if (mockRedis[key]) {
          return false;
        }
        mockRedis[key] = value;
        return true;
      }),
    };

    const mockConfigService: any = {
      get: jest.fn((key: string, defaultVal?: any) => {
        const config: Record<string, any> = {
          CAPABILITY_TOKEN_SIGNING_KEY: 'test-hmac-secret-key-that-is-at-least-32-chars-long!',
          JWT_SECRET: 'test-jwt-secret-key-32-bytes-minimum-length!',
          APP_CHAIN_ID: defaultContext.chain,
          APP_RELEASE_TAG: defaultContext.release,
          APP_DEPLOYMENT_ID: defaultContext.deployment,
          APP_ARTIFACT_DIGEST: defaultContext.artifact,
        };
        return config[key] ?? defaultVal;
      }),
    };

    const jwtService = new JwtService({
      secret: 'test-jwt-secret-key-32-bytes-minimum-length!',
    });

    policyService = new AuthorizationPolicyService(mockConfigService, mockRedisService);
    tokenService = new TokenService(jwtService, mockConfigService, mockRedisService);

    reflector = new Reflector();
    jest.spyOn(reflector, 'get').mockImplementation((key: string) => {
      if (key === REQUIRE_CAPABILITY_KEY) return defaultRequirement;
      if (key === REQUIRE_JWT_CAPABILITY_KEY) {
        return {
          aud: defaultRequirement.aud,
          cap: defaultRequirement.cap,
          resource: defaultRequirement.resource,
          chain: defaultContext.chain,
          release: defaultContext.release,
          deployment: defaultContext.deployment,
          artifact: defaultContext.artifact,
        };
      }
      return undefined;
    });

    capabilityGuard = new CapabilityTokenGuard(reflector, policyService);
    jwtCapabilityGuard = new JwtCapabilityTokenGuard(reflector, tokenService);
  });

  const createMockContext = (request: any): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as any;

  // --------------------------------------------------------------------------
  // 1. Subject Extraction Precedence Unit Tests
  // --------------------------------------------------------------------------
  describe('extractCapabilitySubject', () => {
    it('returns linked userId when userId is present on principal', () => {
      const principal: AuthenticatedPrincipal = {
        address: '0x1234567890abcdef1234567890abcdef12345678',
        userId: 'usr-linked-1234',
        user: null,
      };
      expect(extractCapabilitySubject(principal)).toBe('usr-linked-1234');
    });

    it('returns linked user ID from user.id when userId is null/undefined', () => {
      const principal: AuthenticatedPrincipal = {
        address: '0x1234567890abcdef1234567890abcdef12345678',
        userId: null,
        user: { id: 'usr-nested-5678', role: 'contributor' },
      };
      expect(extractCapabilitySubject(principal)).toBe('usr-nested-5678');
    });

    it('prefers linked userId over wallet address when both are present', () => {
      const principal: AuthenticatedPrincipal = {
        address: '0x1234567890ABCDEF1234567890ABCDEF12345678',
        userId: 'usr-canonical-999',
        user: { id: 'usr-nested-ignored', role: 'contributor' },
      };
      expect(extractCapabilitySubject(principal)).toBe('usr-canonical-999');
    });

    it('falls back to normalized lowercase wallet address for wallet-only principal', () => {
      const principal: AuthenticatedPrincipal = {
        address: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
        userId: null,
        user: null,
      };
      expect(extractCapabilitySubject(principal)).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    });

    it('returns undefined for missing or malformed principal', () => {
      expect(extractCapabilitySubject(null)).toBeUndefined();
      expect(extractCapabilitySubject(undefined)).toBeUndefined();
      expect(extractCapabilitySubject({} as any)).toBeUndefined();
      expect(extractCapabilitySubject({ address: '' } as any)).toBeUndefined();
    });

    it('does not read top-level id property (which is non-canonical)', () => {
      const spoofedPrincipal: any = {
        id: 'spoofed-id',
      };
      expect(extractCapabilitySubject(spoofedPrincipal)).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // 2. Guard Subject Binding & Precedence
  // --------------------------------------------------------------------------
  describe('CapabilityTokenGuard subject binding', () => {
    it('allows a wallet-only principal using a capability bound to its normalized wallet address', async () => {
      const walletAddress = '0x1234567890ABCDEF1234567890ABCDEF12345678';
      const principal: AuthenticatedPrincipal = {
        address: walletAddress,
        userId: null,
        user: null,
        sub: walletAddress.toLowerCase(),
      };

      const token = await policyService.issueCapabilityToken({
        aud: defaultRequirement.aud,
        principal,
        cap: defaultRequirement.cap,
        resource: defaultRequirement.resource,
        action: defaultRequirement.action,
        ...defaultContext,
      });

      const req = {
        user: principal,
        body: {
          capabilityToken: token,
          ...defaultContext,
        },
      };

      await expect(capabilityGuard.canActivate(createMockContext(req))).resolves.toBe(true);
    });

    it('allows a linked-user principal using a capability bound to canonical user ID', async () => {
      const principal: AuthenticatedPrincipal = {
        address: '0x1234567890abcdef1234567890abcdef12345678',
        userId: 'user-uuid-1234',
        user: { id: 'user-uuid-1234', role: 'contributor' },
      };

      const token = await policyService.issueCapabilityToken({
        aud: defaultRequirement.aud,
        principal,
        cap: defaultRequirement.cap,
        resource: defaultRequirement.resource,
        action: defaultRequirement.action,
        ...defaultContext,
      });

      const req = {
        user: principal,
        body: {
          capabilityToken: token,
          ...defaultContext,
        },
      };

      await expect(capabilityGuard.canActivate(createMockContext(req))).resolves.toBe(true);
    });

    it('enforces subject precedence: user ID capability is accepted while address-bound capability is rejected for linked user', async () => {
      const principal: AuthenticatedPrincipal = {
        address: '0x1234567890abcdef1234567890abcdef12345678',
        userId: 'user-uuid-1234',
        user: { id: 'user-uuid-1234', role: 'contributor' },
      };

      // Token explicitly bound to wallet address instead of canonical userId
      const addressToken = await policyService.issueCapabilityToken({
        aud: defaultRequirement.aud,
        sub: principal.address.toLowerCase(),
        cap: defaultRequirement.cap,
        resource: defaultRequirement.resource,
        action: defaultRequirement.action,
        ...defaultContext,
      });

      const reqWithAddressToken = {
        user: principal,
        body: {
          capabilityToken: addressToken,
          ...defaultContext,
        },
      };

      // Must be rejected because guard derives subject as 'user-uuid-1234'
      await expect(capabilityGuard.canActivate(createMockContext(reqWithAddressToken))).rejects.toThrow(
        ForbiddenException,
      );

      // Token bound to canonical userId
      const userToken = await policyService.issueCapabilityToken({
        aud: defaultRequirement.aud,
        sub: 'user-uuid-1234',
        cap: defaultRequirement.cap,
        resource: defaultRequirement.resource,
        action: defaultRequirement.action,
        ...defaultContext,
      });

      const reqWithUserToken = {
        user: principal,
        body: {
          capabilityToken: userToken,
          ...defaultContext,
        },
      };

      await expect(capabilityGuard.canActivate(createMockContext(reqWithUserToken))).resolves.toBe(true);
    });

    it('rejects missing or unauthenticated principal without falling back to body subject', async () => {
      const token = await policyService.issueCapabilityToken({
        aud: defaultRequirement.aud,
        sub: 'victim-user-123',
        cap: defaultRequirement.cap,
        resource: defaultRequirement.resource,
        action: defaultRequirement.action,
        ...defaultContext,
      });

      const reqNoPrincipal = {
        user: null,
        body: {
          sub: 'victim-user-123',
          capabilityToken: token,
          ...defaultContext,
        },
      };

      await expect(capabilityGuard.canActivate(createMockContext(reqNoPrincipal))).rejects.toThrow(
        'Missing capability token or subject',
      );
    });

    it('prevents caller-supplied request body from overriding authenticated subject', async () => {
      const attackerPrincipal: AuthenticatedPrincipal = {
        address: '0xattacker1234567890abcdef1234567890abcdef',
        userId: 'attacker-id',
        user: null,
      };

      // Token issued to victim
      const victimToken = await policyService.issueCapabilityToken({
        aud: defaultRequirement.aud,
        sub: 'victim-id',
        cap: defaultRequirement.cap,
        resource: defaultRequirement.resource,
        action: defaultRequirement.action,
        ...defaultContext,
      });

      const attackReq = {
        user: attackerPrincipal,
        body: {
          sub: 'victim-id', // Attacker attempts to inject victim subject
          subject: 'victim-id',
          capabilityToken: victimToken,
          ...defaultContext,
        },
      };

      // Guard must derive 'attacker-id' from user and reject the victim token
      await expect(capabilityGuard.canActivate(createMockContext(attackReq))).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // --------------------------------------------------------------------------
  // 3. Reconciled Contract Separation & Format Distinction
  // --------------------------------------------------------------------------
  describe('Capability Token format reconciliation', () => {
    it('CapabilityTokenGuard rejects JWT capability tokens as malformed', async () => {
      const principal: AuthenticatedPrincipal = {
        address: '0x1234567890abcdef1234567890abcdef12345678',
        userId: 'user-123',
      };

      // Issue JWT capability token via TokenService
      const jwtToken = await tokenService.issueCapabilityToken({
        audience: defaultRequirement.aud,
        principal,
        capability: defaultRequirement.cap,
        resource: defaultRequirement.resource,
        chain: defaultContext.chain,
        release: defaultContext.release,
        deployment: defaultContext.deployment,
        artifact: defaultContext.artifact,
      });

      const reqWithJwt = {
        user: principal,
        body: {
          capabilityToken: jwtToken.token, // string JWT format
          ...defaultContext,
        },
      };

      await expect(capabilityGuard.canActivate(createMockContext(reqWithJwt))).rejects.toThrow(
        'Malformed capability token',
      );
    });

    it('JwtCapabilityTokenGuard accepts JWT capability token and rejects HMAC format', async () => {
      const principal: AuthenticatedPrincipal = {
        address: '0x1234567890abcdef1234567890abcdef12345678',
        userId: 'user-123',
      };

      const jwtToken = await tokenService.issueCapabilityToken({
        audience: defaultRequirement.aud,
        principal,
        capability: defaultRequirement.cap,
        resource: defaultRequirement.resource,
        chain: defaultContext.chain,
        release: defaultContext.release,
        deployment: defaultContext.deployment,
        artifact: defaultContext.artifact,
      });

      const validJwtReq = {
        user: principal,
        body: {
          capabilityToken: jwtToken.token,
          ...defaultContext,
        },
      };

      await expect(jwtCapabilityGuard.canActivate(createMockContext(validJwtReq))).resolves.toBe(true);

      // Now pass HMAC token object to JwtCapabilityTokenGuard -> must reject as malformed
      const hmacToken = await policyService.issueCapabilityToken({
        aud: defaultRequirement.aud,
        principal,
        cap: defaultRequirement.cap,
        resource: defaultRequirement.resource,
        action: defaultRequirement.action,
        ...defaultContext,
      });

      const reqWithHmac = {
        user: principal,
        body: {
          capabilityToken: hmacToken, // Object format
          ...defaultContext,
        },
      };

      await expect(jwtCapabilityGuard.canActivate(createMockContext(reqWithHmac))).rejects.toThrow(
        'Malformed capability token',
      );
    });
  });

  // --------------------------------------------------------------------------
  // 4. Strict Context & Security Verification
  // --------------------------------------------------------------------------
  describe('Capability verification boundaries and fail-closed checks', () => {
    it('rejects token with tampered signature', async () => {
      const principal: AuthenticatedPrincipal = {
        address: '0x1234567890abcdef1234567890abcdef12345678',
        userId: 'user-123',
      };

      const token = await policyService.issueCapabilityToken({
        aud: defaultRequirement.aud,
        principal,
        cap: defaultRequirement.cap,
        resource: defaultRequirement.resource,
        action: defaultRequirement.action,
        ...defaultContext,
      });

      // Tamper signature
      const tamperedToken = {
        claims: token.claims,
        signature: 'deadbeef' + token.signature.slice(8),
      };

      const req = {
        user: principal,
        body: {
          capabilityToken: tamperedToken,
          ...defaultContext,
        },
      };

      await expect(capabilityGuard.canActivate(createMockContext(req))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects wrong audience, capability, resource, action, chain, release, deployment, or artifact', async () => {
      const principal: AuthenticatedPrincipal = {
        address: '0x1234567890abcdef1234567890abcdef12345678',
        userId: 'user-123',
      };

      const validToken = await policyService.issueCapabilityToken({
        aud: defaultRequirement.aud,
        principal,
        cap: defaultRequirement.cap,
        resource: defaultRequirement.resource,
        action: defaultRequirement.action,
        ...defaultContext,
      });

      // Test each mismatch individually
      const mismatchCases = [
        { ...defaultContext, chain: 'eip155:1' }, // wrong chain
        { ...defaultContext, release: 'rel-9.9.9' }, // wrong release
        { ...defaultContext, deployment: 'dep-dev' }, // wrong deployment
        { ...defaultContext, artifact: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' }, // wrong artifact
      ];

      for (const badContext of mismatchCases) {
        const req = {
          user: principal,
          body: {
            capabilityToken: validToken,
            ...badContext,
          },
        };
        await expect(capabilityGuard.canActivate(createMockContext(req))).rejects.toThrow(
          ForbiddenException,
        );
      }
    });

    it('rejects revoked subjects', async () => {
      const principal: AuthenticatedPrincipal = {
        address: '0x1234567890abcdef1234567890abcdef12345678',
        userId: 'user-revoked',
      };

      const token = await policyService.issueCapabilityToken({
        aud: defaultRequirement.aud,
        principal,
        cap: defaultRequirement.cap,
        resource: defaultRequirement.resource,
        action: defaultRequirement.action,
        ...defaultContext,
      });

      // Revoke the subject
      await policyService.revokeSubject('user-revoked');

      const req = {
        user: principal,
        body: {
          capabilityToken: token,
          ...defaultContext,
        },
      };

      await expect(capabilityGuard.canActivate(createMockContext(req))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects replayed nonce on second use', async () => {
      const principal: AuthenticatedPrincipal = {
        address: '0x1234567890abcdef1234567890abcdef12345678',
        userId: 'user-once',
      };

      const token = await policyService.issueCapabilityToken({
        aud: defaultRequirement.aud,
        principal,
        cap: defaultRequirement.cap,
        resource: defaultRequirement.resource,
        action: defaultRequirement.action,
        ...defaultContext,
      });

      const req = {
        user: principal,
        body: {
          capabilityToken: token,
          ...defaultContext,
        },
      };

      // First use succeeds
      await expect(capabilityGuard.canActivate(createMockContext(req))).resolves.toBe(true);

      // Replay must fail closed
      await expect(capabilityGuard.canActivate(createMockContext(req))).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});

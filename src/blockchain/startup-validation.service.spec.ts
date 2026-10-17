import { Test } from '@nestjs/testing';
import { StartupValidationService } from './startup-validation.service';
import { ConfigService } from '@nestjs/config';
import { ContractConfig } from '../config/event-indexer.config';
import { RealtimeConfig } from '../config/realtime.config';

describe('StartupValidationService', () => {
  let service: StartupValidationService;
  let configService: { get: jest.Mock };

  const validContract = (): ContractConfig => ({
    name: 'StakeContract',
    address: '0x0000000000000000000000000000000000000001',
    startBlock: 1000,
    events: [
      {
        name: 'Staked',
        signature: '0x0',
        abi: 'event Staked(address indexed user, uint256 amount)',
      },
    ],
  });

  const validRealtime = (): RealtimeConfig => ({
    releaseId: 'wave-9',
    chainId: 10,
    deploymentBlock: 1000,
    artifactChecksum: '0x' + 'a'.repeat(64),
    heartbeatMs: 15000,
    retentionMs: 60000,
    maxPayloadBytes: 65536,
    origins: ['https://app.example.com'],
    topics: [
      { name: 'public:stakes', visibility: 'public', capabilities: [] },
      {
        name: 'protected:stakes',
        visibility: 'protected',
        capabilities: ['stakes:read'],
      },
    ],
  });

  beforeEach(async () => {
    configService = {
      get: jest.fn((key: string, def?: unknown) => {
        const map: Record<string, unknown> = {
          BLOCKCHAIN_STARTUP_VALIDATION: 'false',
          BLOCKCHAIN_STARTUP_RPC_CHECK: 'false',
          INDEXED_CONTRACTS: JSON.stringify([validContract()]),
          CHAIN_ID: '10',
          OPTIMISM_RPC_URL: 'https://mainnet.optimism.io',
          REALTIME_CONFIG: JSON.stringify(validRealtime()),
          SUPPORTED_RELEASE_ID: 'wave-9',
        };
        return key in map ? map[key] : def;
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        StartupValidationService,
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = moduleRef.get(StartupValidationService);
  });

  it('validates a well-formed contract config without errors', () => {
    const result = service.validateContract(validContract());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('flags an invalid (non-hex / wrong length) address', () => {
    const contract = validContract();
    contract.address = 'not-an-address';
    const result = service.validateContract(contract);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('not a valid 20-byte hex');
  });

  it('flags a non-checksummed address', () => {
    const contract = validContract();
    // a mixed-case address that is not the correct EIP-55 checksum casing
    contract.address = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
    const result = service.validateContract(contract);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/checksum/i);
  });

  it('flags a malformed ABI fragment', () => {
    const contract = validContract();
    contract.events[0].abi = 'not an abi';
    const result = service.validateContract(contract);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('ABI is invalid');
  });

  it('flags a contract with no events', () => {
    const contract = validContract();
    contract.events = [];
    const result = service.validateContract(contract);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('no events');
  });

  it('skips when startup validation is disabled by config', async () => {
    configService.get.mockImplementation((key: string, def?: unknown) => {
      if (key === 'BLOCKCHAIN_STARTUP_VALIDATION') return 'false';
      return def;
    });
    await expect(service.onApplicationBootstrap()).resolvesToBeUndefined();
  });

  it('throws (fail-closed) when a configured contract is invalid', async () => {
    configService.get.mockImplementation((key: string, def?: unknown) => {
      const map: Record<string, unknown> = {
        BLOCKCHAIN_STARTUP_VALIDATION: undefined, // not disabled
        BLOCKCHAIN_STARTUP_RPC_CHECK: 'false', // avoid network
        INDEXED_CONTRACTS: JSON.stringify([
          { name: 'Bad', address: '0xZZZ', events: [] },
        ]),
      };
      return map[key] ?? def;
    });
    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      /startup validation failed/i,
    );
  });

  describe('realtime configuration', () => {
    it('accepts a well-formed realtime config', () => {
      const result = service.validateRealtime(validRealtime());
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('rejects an unknown topic name', () => {
      const config = validRealtime();
      config.topics.push({ name: 'unknown:topic', visibility: 'public', capabilities: [] });
      const result = service.validateRealtime(config);
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/unknown topic/i);
    });

    it('rejects wildcard topic patterns', () => {
      const config = validRealtime();
      config.topics[0].name = 'public:*';
      const result = service.validateRealtime(config);
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/wildcard/i);
    });

    it('rejects topic names that could inject Redis/WebSocket patterns', () => {
      const config = validRealtime();
      config.topics[0].name = 'public:stakes\n*';
      const result = service.validateRealtime(config);
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/invalid topic name/i);
    });

    it('rejects oversized payload limits', () => {
      const config = validRealtime();
      config.maxPayloadBytes = 10 * 1024 * 1024;
      const result = service.validateRealtime(config);
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/payload/i);
    });

    it('rejects a stale release id', () => {
      const config = validRealtime();
      config.releaseId = 'wave-8';
      const result = service.validateRealtime(config);
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/stale release/i);
    });

    it('rejects a chain id mismatch', () => {
      const config = validRealtime();
      config.chainId = 1;
      const result = service.validateRealtime(config);
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/chain id/i);
    });

    it('rejects an unapproved origin', () => {
      const config = validRealtime();
      config.origins.push('https://evil.example.com');
      const result = service.validateRealtime(config);
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/origin/i);
    });

    it('rejects a protected topic without capabilities', () => {
      const config = validRealtime();
      config.topics[1].capabilities = [];
      const result = service.validateRealtime(config);
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/capabilit/i);
    });
  });

  describe('topic authorization', () => {
    it('allows a public topic for an anonymous principal', () => {
      const result = service.authorizeTopic(
        validRealtime(),
        { capabilities: [], sessionRevoked: false },
        'public:stakes',
      );
      expect(result.authorized).toBe(true);
    });

    it('denies a protected topic without the required capability', () => {
      const result = service.authorizeTopic(
        validRealtime(),
        { capabilities: [], sessionRevoked: false },
        'protected:stakes',
      );
      expect(result.authorized).toBe(false);
    });

    it('allows a protected topic with the required capability', () => {
      const result = service.authorizeTopic(
        validRealtime(),
        { capabilities: ['stakes:read'], sessionRevoked: false },
        'protected:stakes',
      );
      expect(result.authorized).toBe(true);
    });

    it('denies an unknown topic', () => {
      const result = service.authorizeTopic(
        validRealtime(),
        { capabilities: ['stakes:read'], sessionRevoked: false },
        'unknown:topic',
      );
      expect(result.authorized).toBe(false);
    });

    it('denies a revoked session', () => {
      const result = service.authorizeTopic(
        validRealtime(),
        { capabilities: ['stakes:read'], sessionRevoked: true },
        'protected:stakes',
      );
      expect(result.authorized).toBe(false);
    });

    it('denies wildcard escalation attempts', () => {
      const result = service.authorizeTopic(
        validRealtime(),
        { capabilities: ['stakes:read'], sessionRevoked: false },
        'protected:*',
      );
      expect(result.authorized).toBe(false);
    });
  });

  it('fails startup when realtime config is invalid', async () => {
    configService.get.mockImplementation((key: string, def?: unknown) => {
      const map: Record<string, unknown> = {
        BLOCKCHAIN_STARTUP_VALIDATION: undefined,
        BLOCKCHAIN_STARTUP_RPC_CHECK: 'false',
        INDEXED_CONTRACTS: JSON.stringify([validContract()]),
        CHAIN_ID: '10',
        REALTIME_CONFIG: JSON.stringify({ ...validRealtime(), releaseId: 'wave-8' }),
        SUPPORTED_RELEASE_ID: 'wave-9',
      };
      return map[key] ?? def;
    });
    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      /startup validation failed/i,
    );
  });
});

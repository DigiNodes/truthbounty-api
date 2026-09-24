import { Test } from '@nestjs/testing';
import { StartupValidationService } from './startup-validation.service';
import { ConfigService } from '@nestjs/config';
import { ContractConfig } from '../config/event-indexer.config';

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

  beforeEach(async () => {
    configService = {
      get: jest.fn((key: string, def?: unknown) => {
        const map: Record<string, unknown> = {
          BLOCKCHAIN_STARTUP_VALIDATION: 'false',
          BLOCKCHAIN_STARTUP_RPC_CHECK: 'false',
          INDEXED_CONTRACTS: JSON.stringify([validContract()]),
          CHAIN_ID: '10',
          OPTIMISM_RPC_URL: 'https://mainnet.optimism.io',
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
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
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
});

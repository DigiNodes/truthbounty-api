import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  DeterministicRpcFailoverService,
  ProviderHealthStatus,
  RpcFailoverExhaustedException,
  ChainMismatchException,
} from './deterministic-rpc-failover.service';

describe('DeterministicRpcFailoverService', () => {
  let service: DeterministicRpcFailoverService;

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: any) => {
      if (key === 'blockchain.rpcUrl') return 'https://primary-rpc.optimism.io/v3/secret-key-1234567890';
      if (key === 'blockchain.fallbackRpcUrls') return ['https://fallback-1.optimism.io', 'https://fallback-2.optimism.io'];
      if (key === 'blockchain.chainId') return 10;
      if (key === 'blockchain.rpcTimeoutMs') return 500;
      return defaultValue;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeterministicRpcFailoverService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<DeterministicRpcFailoverService>(DeterministicRpcFailoverService);
  });

  describe('Initialization and Redaction', () => {
    it('initializes providers in deterministic order and sanitizes secret credentials', () => {
      const statuses = service.getStatuses();
      expect(statuses).toHaveLength(3);
      expect(statuses[0].index).toBe(0);
      expect(statuses[1].index).toBe(1);
      expect(statuses[2].index).toBe(2);

      // Secret key in primary endpoint should be redacted
      expect(statuses[0].endpoint).not.toContain('secret-key-1234567890');
      expect(statuses[0].endpoint).toContain('...');
    });
  });

  describe('execute failover logic', () => {
    it('succeeds on primary provider without calling fallbacks', async () => {
      const mockOp = jest.fn().mockResolvedValue('block_0x123');

      const result = await service.execute(mockOp, 'getBlock');

      expect(result).toBe('block_0x123');
      expect(mockOp).toHaveBeenCalledTimes(1);
      const statuses = service.getStatuses();
      expect(statuses[0].status).toBe(ProviderHealthStatus.HEALTHY);
    });

    it('deterministically fails over to secondary provider when primary fails', async () => {
      const mockOp = jest
        .fn()
        .mockRejectedValueOnce(new Error('Rate limit 429'))
        .mockResolvedValueOnce('block_0xsecondary');

      const result = await service.execute(mockOp, 'getBlock');

      expect(result).toBe('block_0xsecondary');
      expect(mockOp).toHaveBeenCalledTimes(2);

      const statuses = service.getStatuses();
      expect(statuses[0].status).toBe(ProviderHealthStatus.DEGRADED);
      expect(statuses[0].consecutiveFailures).toBe(1);
      expect(statuses[1].status).toBe(ProviderHealthStatus.HEALTHY);
    });

    it('fails closed and throws RpcFailoverExhaustedException when all providers fail', async () => {
      const mockOp = jest.fn().mockRejectedValue(new Error('Connection refused'));

      await expect(service.execute(mockOp, 'getBlock')).rejects.toThrow(
        RpcFailoverExhaustedException,
      );

      // Should have attempted all 3 configured providers deterministically
      expect(mockOp).toHaveBeenCalledTimes(3);

      const statuses = service.getStatuses();
      expect(statuses[0].consecutiveFailures).toBe(1);
      expect(statuses[1].consecutiveFailures).toBe(1);
      expect(statuses[2].consecutiveFailures).toBe(1);
    });
  });

  describe('Chain Verification', () => {
    it('throws ChainMismatchException and marks provider UNHEALTHY if chainId does not match canonical Optimism', async () => {
      const testNode = (service as any).providers[0];
      jest.spyOn(testNode.provider, 'getNetwork').mockResolvedValue({ chainId: 1n } as any); // Ethereum mainnet instead of Optimism 10

      await expect(service.verifyChain(testNode)).rejects.toThrow(ChainMismatchException);
      expect(testNode.status).toBe(ProviderHealthStatus.UNHEALTHY);
    });
  });
});

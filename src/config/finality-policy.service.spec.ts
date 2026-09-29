import { ConfigService } from '@nestjs/config';
import { FinalityPolicyService } from './finality-policy.service';
import { DataState } from '../v2/common/data-state.enum';

function buildService(overrides: Record<string, unknown> = {}): FinalityPolicyService {
  const values: Record<string, unknown> = {
    'finalityPolicy.chainId': 10,
    'finalityPolicy.allowedChainIds': [10, 11155420],
    'finalityPolicy.safeConfirmations': 1,
    'finalityPolicy.finalizedConfirmations': 12,
    ...overrides,
  };
  const configService = {
    get: jest.fn((key: string, defaultValue?: unknown) =>
      key in values ? values[key] : defaultValue,
    ),
  } as unknown as ConfigService;
  return new FinalityPolicyService(configService);
}

describe('FinalityPolicyService', () => {
  describe('validate (startup, fail-closed)', () => {
    it('passes for valid Optimism mainnet config', () => {
      const service = buildService();
      expect(service.validate()).toEqual({
        chainId: 10,
        safeConfirmations: 1,
        finalizedConfirmations: 12,
      });
    });

    it('passes for valid Optimism Sepolia config', () => {
      const service = buildService({ 'finalityPolicy.chainId': 11155420 });
      expect(() => service.validate()).not.toThrow();
    });

    it('throws for an unrecognized chain id (non-Optimism network)', () => {
      const service = buildService({ 'finalityPolicy.chainId': 1 }); // Ethereum mainnet
      expect(() => service.validate()).toThrow(/not a recognized Optimism network/);
    });

    it('throws for a non-integer chain id (NaN from a malformed env var)', () => {
      const service = buildService({ 'finalityPolicy.chainId': NaN });
      expect(() => service.validate()).toThrow(/CHAIN_ID must resolve to a positive integer/);
    });

    it('throws for negative confirmations', () => {
      const service = buildService({ 'finalityPolicy.safeConfirmations': -1 });
      expect(() => service.validate()).toThrow(/FINALITY_SAFE_CONFIRMATIONS must resolve to a non-negative integer/);
    });

    it('throws for NaN confirmations (e.g. non-numeric env value)', () => {
      const service = buildService({ 'finalityPolicy.finalizedConfirmations': NaN });
      expect(() => service.validate()).toThrow(/FINALITY_FINALIZED_CONFIRMATIONS must resolve to a non-negative integer/);
    });

    it('throws when safeConfirmations exceeds finalizedConfirmations', () => {
      const service = buildService({
        'finalityPolicy.safeConfirmations': 20,
        'finalityPolicy.finalizedConfirmations': 12,
      });
      expect(() => service.validate()).toThrow(/must be <= finalizedConfirmations/);
    });

    it('throws when confirmations exceed the sane upper bound', () => {
      const service = buildService({ 'finalityPolicy.finalizedConfirmations': 1_000_000 });
      expect(() => service.validate()).toThrow(/exceeds the sane upper bound/);
    });

    it('accepts safeConfirmations equal to finalizedConfirmations (boundary)', () => {
      const service = buildService({
        'finalityPolicy.safeConfirmations': 12,
        'finalityPolicy.finalizedConfirmations': 12,
      });
      expect(() => service.validate()).not.toThrow();
    });

    it('accepts zero confirmations (boundary: immediate observation counts as safe)', () => {
      const service = buildService({ 'finalityPolicy.safeConfirmations': 0 });
      expect(() => service.validate()).not.toThrow();
    });
  });

  describe('classifyByConfirmations', () => {
    const service = buildService();

    it('returns OBSERVED below the safe threshold', () => {
      expect(service.classifyByConfirmations(100n, 100n)).toBe(DataState.OBSERVED); // 0 confirmations
    });

    it('returns SAFE at the safe boundary', () => {
      expect(service.classifyByConfirmations(100n, 101n)).toBe(DataState.SAFE); // 1 confirmation, safe=1
    });

    it('returns SAFE below the finalized threshold', () => {
      expect(service.classifyByConfirmations(100n, 105n)).toBe(DataState.SAFE); // 5 confirmations
    });

    it('returns FINALIZED at the finalized boundary', () => {
      expect(service.classifyByConfirmations(100n, 112n)).toBe(DataState.FINALIZED); // 12 confirmations
    });

    it('returns FINALIZED well beyond the finalized threshold', () => {
      expect(service.classifyByConfirmations(100n, 1000n)).toBe(DataState.FINALIZED);
    });

    it('returns OBSERVED when the target block has not been reached yet', () => {
      expect(service.classifyByConfirmations(200n, 100n)).toBe(DataState.OBSERVED);
    });

    it('is deterministic and side-effect-free across repeated/concurrent calls', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => Promise.resolve(service.classifyByConfirmations(100n, 112n))),
      );
      expect(new Set(results)).toEqual(new Set([DataState.FINALIZED]));
    });
  });

  describe('classifyByCheckpoint', () => {
    const service = buildService();

    it('returns OBSERVED when no checkpoint exists', () => {
      expect(service.classifyByCheckpoint('100', null)).toBe(DataState.OBSERVED);
    });

    it('returns FINALIZED when block is at or below lastFinalizedBlock', () => {
      const checkpoint = { lastSafeBlock: '150', lastFinalizedBlock: '100' };
      expect(service.classifyByCheckpoint('100', checkpoint)).toBe(DataState.FINALIZED);
      expect(service.classifyByCheckpoint('50', checkpoint)).toBe(DataState.FINALIZED);
    });

    it('returns SAFE when block is above finalized but at or below safe', () => {
      const checkpoint = { lastSafeBlock: '150', lastFinalizedBlock: '100' };
      expect(service.classifyByCheckpoint('150', checkpoint)).toBe(DataState.SAFE);
      expect(service.classifyByCheckpoint('120', checkpoint)).toBe(DataState.SAFE);
    });

    it('returns OBSERVED when block is above safe', () => {
      const checkpoint = { lastSafeBlock: '150', lastFinalizedBlock: '100' };
      expect(service.classifyByCheckpoint('151', checkpoint)).toBe(DataState.OBSERVED);
    });
  });

  describe('isFinalized / isProvisional', () => {
    const service = buildService();

    it('treats only FINALIZED as final', () => {
      expect(service.isFinalized(DataState.FINALIZED)).toBe(true);
      expect(service.isFinalized(DataState.SAFE)).toBe(false);
      expect(service.isFinalized(DataState.OBSERVED)).toBe(false);
    });

    it('treats OBSERVED and SAFE as provisional', () => {
      expect(service.isProvisional(DataState.OBSERVED)).toBe(true);
      expect(service.isProvisional(DataState.SAFE)).toBe(true);
      expect(service.isProvisional(DataState.FINALIZED)).toBe(false);
    });
  });
});

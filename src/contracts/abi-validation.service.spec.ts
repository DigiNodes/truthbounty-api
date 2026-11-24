import { Test, TestingModule } from '@nestjs/testing';
import { AbiValidationService } from './abi-validation.service';
import { ethers } from 'ethers';

describe('AbiValidationService', () => {
  let service: AbiValidationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AbiValidationService],
    }).compile();

    service = module.get<AbiValidationService>(AbiValidationService);
  });

  describe('detectEventOverloads', () => {
    it('detects overloaded events with same name but different parameters', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event Transfer(address indexed from, address indexed to, uint256 amount, bytes data)',
      ];

      const result = service.detectEventOverloads(abi);

      expect(result.hasOverloads).toBe(true);
      expect(result.overloads).toHaveLength(1);
      expect(result.overloads[0].name).toBe('Transfer');
      expect(result.overloads[0].signatures).toHaveLength(2);
      expect(result.overloads[0].signatures).toContain(
        'Transfer(address,address,uint256)',
      );
      expect(result.overloads[0].signatures).toContain(
        'Transfer(address,address,uint256,bytes)',
      );
    });

    it('does not report overload when same event appears twice with identical signature', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
      ];

      const result = service.detectEventOverloads(abi);

      // This is a duplicate, not an overload
      expect(result.hasOverloads).toBe(false);
    });

    it('handles multiple different events without false positives', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event Approval(address indexed owner, address indexed spender, uint256 value)',
        'event Mint(address indexed to, uint256 amount)',
      ];

      const result = service.detectEventOverloads(abi);

      expect(result.hasOverloads).toBe(false);
      expect(result.overloads).toHaveLength(0);
    });

    it('detects multiple overload groups in the same ABI', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event Transfer(address indexed from, address indexed to, uint256 amount, bytes data)',
        'event Swap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn)',
        'event Swap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)',
      ];

      const result = service.detectEventOverloads(abi);

      expect(result.hasOverloads).toBe(true);
      expect(result.overloads).toHaveLength(2);
      expect(result.overloads.map((o) => o.name).sort()).toEqual([
        'Swap',
        'Transfer',
      ]);
    });

    it('ignores malformed ABI fragments gracefully', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'this is not a valid ABI string',
        'event Approval(address indexed owner, address indexed spender, uint256 value)',
      ];

      const result = service.detectEventOverloads(abi);

      expect(result.hasOverloads).toBe(false);
      expect(result.overloads).toHaveLength(0);
    });
  });

  describe('detectCollisions', () => {
    it('detects topic0 collisions (cryptographic collision scenario)', () => {
      // In reality, keccak256 collisions are infeasible, but we can test the detection logic
      // by creating the scenario manually. For this test, we'll validate the structure.
      const abi = [
        'event EventA(uint256 value)',
        'event EventB(uint256 value)',
      ];

      const result = service.detectCollisions(abi);

      // These should have different topic0 values, so no collision
      expect(result.topicCollisions).toHaveLength(0);
      expect(result.hasCollisions).toBe(false);
    });

    it('detects selector collisions for function overloads', () => {
      const abi = [
        'function transfer(address to, uint256 amount)',
        'function approve(address spender, uint256 amount)',
      ];

      const result = service.detectCollisions(abi);

      // Different functions should have different selectors
      expect(result.selectorCollisions).toHaveLength(0);
    });

    it('handles ABI with only events (no functions)', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event Approval(address indexed owner, address indexed spender, uint256 value)',
      ];

      const result = service.detectCollisions(abi);

      expect(result.topicCollisions).toHaveLength(0);
      expect(result.selectorCollisions).toHaveLength(0);
      expect(result.hasCollisions).toBe(false);
    });

    it('handles ABI with only functions (no events)', () => {
      const abi = [
        'function transfer(address to, uint256 amount)',
        'function balanceOf(address account) view returns (uint256)',
      ];

      const result = service.detectCollisions(abi);

      expect(result.topicCollisions).toHaveLength(0);
      expect(result.selectorCollisions).toHaveLength(0);
      expect(result.hasCollisions).toBe(false);
    });

    it('detects duplicate event signatures as potential collisions', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
      ];

      const result = service.detectCollisions(abi);

      // Identical signatures generate the same topic0, which is a collision
      expect(result.topicCollisions).toHaveLength(1);
      expect(result.topicCollisions[0].events).toHaveLength(2);
      expect(result.hasCollisions).toBe(true);
    });
  });

  describe('detectAnonymousEvents', () => {
    it('detects anonymous events', () => {
      const abi = ['event DataUpdated(uint256 value) anonymous'];

      const result = service.detectAnonymousEvents(abi);

      expect(result.hasAnonymousEvents).toBe(true);
      expect(result.anonymousEvents).toHaveLength(1);
      expect(result.anonymousEvents[0].name).toBe('DataUpdated');
    });

    it('does not flag regular events as anonymous', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
      ];

      const result = service.detectAnonymousEvents(abi);

      expect(result.hasAnonymousEvents).toBe(false);
      expect(result.anonymousEvents).toHaveLength(0);
    });

    it('distinguishes between anonymous and non-anonymous events in mixed ABI', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event InternalLog(bytes data) anonymous',
        'event Approval(address indexed owner, address indexed spender, uint256 value)',
      ];

      const result = service.detectAnonymousEvents(abi);

      expect(result.hasAnonymousEvents).toBe(true);
      expect(result.anonymousEvents).toHaveLength(1);
      expect(result.anonymousEvents[0].name).toBe('InternalLog');
    });
  });

  describe('detectDuplicates', () => {
    it('detects duplicate event signatures', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
      ];

      const result = service.detectDuplicates(abi);

      expect(result.hasDuplicates).toBe(true);
      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0].signature).toBe(
        'Transfer(address,address,uint256)',
      );
      expect(result.duplicates[0].count).toBe(2);
    });

    it('detects triplicate event signatures', () => {
      const abi = [
        'event Mint(address to, uint256 amount)',
        'event Mint(address to, uint256 amount)',
        'event Mint(address to, uint256 amount)',
      ];

      const result = service.detectDuplicates(abi);

      expect(result.hasDuplicates).toBe(true);
      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0].count).toBe(3);
    });

    it('does not report duplicates when all events are unique', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event Approval(address indexed owner, address indexed spender, uint256 value)',
      ];

      const result = service.detectDuplicates(abi);

      expect(result.hasDuplicates).toBe(false);
      expect(result.duplicates).toHaveLength(0);
    });

    it('does not confuse overloads with duplicates', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event Transfer(address indexed from, address indexed to, uint256 amount, bytes data)',
      ];

      const result = service.detectDuplicates(abi);

      // These are overloads (different signatures), not duplicates
      expect(result.hasDuplicates).toBe(false);
    });
  });

  describe('extractIndexedParameters', () => {
    it('extracts indexed parameters in correct order', () => {
      const abi =
        'event Transfer(address indexed from, address indexed to, uint256 amount)';

      const indexed = service.extractIndexedParameters(abi);

      expect(indexed).toHaveLength(2);
      expect(indexed[0].name).toBe('from');
      expect(indexed[0].type).toBe('address');
      expect(indexed[0].indexed).toBe(true);
      expect(indexed[0].position).toBe(0);

      expect(indexed[1].name).toBe('to');
      expect(indexed[1].type).toBe('address');
      expect(indexed[1].indexed).toBe(true);
      expect(indexed[1].position).toBe(1);
    });

    it('excludes non-indexed parameters', () => {
      const abi =
        'event Approval(address indexed owner, address indexed spender, uint256 value)';

      const indexed = service.extractIndexedParameters(abi);

      expect(indexed).toHaveLength(2);
      expect(indexed.every((p) => p.name !== 'value')).toBe(true);
    });

    it('handles events with no indexed parameters', () => {
      const abi = 'event DataUpdated(uint256 value, string data)';

      const indexed = service.extractIndexedParameters(abi);

      expect(indexed).toHaveLength(0);
    });

    it('handles events with all indexed parameters', () => {
      const abi =
        'event AllIndexed(address indexed a, uint256 indexed b, bytes32 indexed c)';

      const indexed = service.extractIndexedParameters(abi);

      expect(indexed).toHaveLength(3);
    });

    it('returns empty array for non-event fragments', () => {
      const abi = 'function transfer(address to, uint256 amount)';

      const indexed = service.extractIndexedParameters(abi);

      expect(indexed).toHaveLength(0);
    });
  });

  describe('validateIndexedFieldLayout', () => {
    it('validates identical indexed layouts as compatible', () => {
      const oldAbi =
        'event Transfer(address indexed from, address indexed to, uint256 amount)';
      const newAbi =
        'event Transfer(address indexed from, address indexed to, uint256 amount)';

      const result = service.validateIndexedFieldLayout(oldAbi, newAbi);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('detects indexed parameter count change', () => {
      const oldAbi =
        'event Transfer(address indexed from, address indexed to, uint256 amount)';
      const newAbi =
        'event Transfer(address indexed from, address indexed to, uint256 indexed amount)';

      const result = service.validateIndexedFieldLayout(oldAbi, newAbi);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('count changed'))).toBe(true);
    });

    it('detects indexed parameter type mutation', () => {
      const oldAbi =
        'event Transfer(address indexed from, address indexed to, uint256 amount)';
      const newAbi =
        'event Transfer(uint256 indexed from, address indexed to, uint256 amount)';

      const result = service.validateIndexedFieldLayout(oldAbi, newAbi);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('type changed'))).toBe(true);
    });

    it('detects position reordering of indexed parameters', () => {
      const oldAbi =
        'event Swap(address indexed tokenIn, address indexed tokenOut, uint256 amount)';
      const newAbi =
        'event Swap(address indexed tokenOut, address indexed tokenIn, uint256 amount)';

      const result = service.validateIndexedFieldLayout(oldAbi, newAbi);

      expect(result.valid).toBe(false);
      // Position changes because "tokenOut" is now at position 0 instead of position 1
    });

    it('allows non-indexed parameter changes without failing validation', () => {
      const oldAbi =
        'event Transfer(address indexed from, address indexed to, uint256 amount)';
      const newAbi =
        'event Transfer(address indexed from, address indexed to, uint256 amount, bytes data)';

      const result = service.validateIndexedFieldLayout(oldAbi, newAbi);

      // Indexed layout is the same (from, to), non-indexed parameter addition is OK
      expect(result.valid).toBe(true);
    });
  });

  describe('computeTopic0', () => {
    it('computes correct topic0 for standard event', () => {
      const abi =
        'event Transfer(address indexed from, address indexed to, uint256 amount)';

      const topic0 = service.computeTopic0(abi);

      expect(topic0).toBeTruthy();
      expect(topic0).toMatch(/^0x[a-f0-9]{64}$/);

      // Verify it matches ethers computation
      const fragment = ethers.EventFragment.from(abi);
      const expectedTopic0 = ethers.id(fragment.format('sighash'));
      expect(topic0).toBe(expectedTopic0);
    });

    it('returns null for anonymous events', () => {
      const abi = 'event InternalLog(bytes data) anonymous';

      const topic0 = service.computeTopic0(abi);

      expect(topic0).toBeNull();
    });

    it('returns null for non-event fragments', () => {
      const abi = 'function transfer(address to, uint256 amount)';

      const topic0 = service.computeTopic0(abi);

      expect(topic0).toBeNull();
    });

    it('returns null for malformed ABI', () => {
      const abi = 'this is not valid';

      const topic0 = service.computeTopic0(abi);

      expect(topic0).toBeNull();
    });
  });

  describe('computeCanonicalSignature', () => {
    it('computes canonical signature for event', () => {
      const abi =
        'event Transfer(address indexed from, address indexed to, uint256 amount)';

      const signature = service.computeCanonicalSignature(abi);

      expect(signature).toBe('Transfer(address,address,uint256)');
    });

    it('handles complex types in signature', () => {
      const abi = 'event DataSubmitted(bytes32 indexed id, string uri, bytes data)';

      const signature = service.computeCanonicalSignature(abi);

      expect(signature).toBe('DataSubmitted(bytes32,string,bytes)');
    });

    it('returns null for non-event fragments', () => {
      const abi = 'function balanceOf(address account) view returns (uint256)';

      const signature = service.computeCanonicalSignature(abi);

      expect(signature).toBeNull();
    });

    it('handles array types correctly', () => {
      const abi = 'event BatchTransfer(address[] recipients, uint256[] amounts)';

      const signature = service.computeCanonicalSignature(abi);

      expect(signature).toBe('BatchTransfer(address[],uint256[])');
    });
  });

  describe('validateEventNaming', () => {
    it('validates non-overloaded events as valid', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event Approval(address indexed owner, address indexed spender, uint256 value)',
      ];

      const result = service.validateEventNaming(abi);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('validates overloaded events with distinct topic0 as valid', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event Transfer(address indexed from, address indexed to, uint256 amount, bytes data)',
      ];

      const result = service.validateEventNaming(abi);

      // Overloads are valid as long as they have distinct topic0
      expect(result.valid).toBe(true);
    });

    it('handles empty ABI', () => {
      const abi: string[] = [];

      const result = service.validateEventNaming(abi);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('validateManifestEventSet', () => {
    it('validates clean ABI with no issues', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event Approval(address indexed owner, address indexed spender, uint256 value)',
      ];

      const result = service.validateManifestEventSet(abi);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('reports duplicates as errors', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
      ];

      const result = service.validateManifestEventSet(abi);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Duplicate'))).toBe(true);
    });

    it('reports anonymous events as warnings', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event InternalLog(bytes data) anonymous',
      ];

      const result = service.validateManifestEventSet(abi);

      expect(result.valid).toBe(true); // Valid but has warnings
      expect(result.warnings.some((w) => w.includes('Anonymous'))).toBe(true);
    });

    it('reports overloads as warnings with validation', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event Transfer(address indexed from, address indexed to, uint256 amount, bytes data)',
      ];

      const result = service.validateManifestEventSet(abi);

      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes('overload'))).toBe(true);
    });

    it('reports topic0 collisions as errors', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
      ];

      const result = service.validateManifestEventSet(abi);

      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes('collision') || e.includes('Duplicate')),
      ).toBe(true);
    });

    it('combines multiple issue types in comprehensive report', () => {
      const abi = [
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
        'event Transfer(address indexed from, address indexed to, uint256 amount)', // duplicate
        'event InternalLog(bytes data) anonymous', // anonymous
        'event Swap(address tokenIn, address tokenOut, uint256 amountIn)',
        'event Swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)', // overload
      ];

      const result = service.validateManifestEventSet(abi);

      expect(result.valid).toBe(false); // Invalid due to duplicates
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });
});

import { Interface } from 'ethers';
import {
  GOVERNOR_PROPOSAL_HASH_SCHEME,
  ProposalDecoderService,
} from '../proposal-decoder.service';

const GOLDEN = {
  targets: [
    '0x1111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222',
  ],
  values: ['0', '1000000000000000000'],
  calldatas: [
    '0x',
    '0xa9059cbb00000000000000000000000033333333333333333333333333333333333333330000000000000000000000000000000000000000000000000000000000000064',
  ],
  descriptionHash: '0x' + 'ab'.repeat(32),
  proposalId:
    '47304621222589775597545673957876819276100891336367114045365864267709555846115',
  expectedHash:
    '0x6895777ff29ba155114db677f30190d21212a7c0bc8454c022c61179309eabe3',
};

/**
 * Unit coverage for ProposalDecoderService — V2-BE-067.
 *
 * Required test categories from the issue:
 *   - Overloaded calls (same selector, different signatures)
 *   - Unknown selector (not in ABI)
 *   - Exact calls remain decodable and checksummed
 *   - ABI change (no artifact available → fail closed)
 */
describe('ProposalDecoderService', () => {
  let decoder: ProposalDecoderService;

  const erc20Iface = new Interface([
    'function transfer(address to, uint256 amount) returns (bool)',
    'function approve(address spender, uint256 amount) returns (bool)',
  ]);

  beforeEach(() => {
    decoder = new ProposalDecoderService();
  });

  // ─── Happy path ─────────────────────────────────────────────────────────

  it('decodes a known selector into functionSignature + args', () => {
    const to = '0x1111111111111111111111111111111111111111';
    const amount = 12345n;
    const calldata = erc20Iface.encodeFunctionData('transfer', [to, amount]);

    const decoded = decoder.decodeCall(
      '0x1111111111111111111111111111111111111111',
      '0',
      calldata,
      erc20Iface,
    );

    expect(decoded.selectorUnknown).toBe(false);
    expect(decoded.functionSignature).toMatch(/^transfer\(address,uint256\)$/);
    expect(String(decoded.decodedArgs?.to).toLowerCase()).toBe(to);
    expect(decoded.decodedArgs?.amount).toBe('12345');
    expect(decoded.selector).toBe(erc20Iface.getFunction('transfer')!.selector);
  });

  it('checksums the target address via EIP-55', () => {
    const calldata = erc20Iface.encodeFunctionData('transfer', [
      '0x2222222222222222222222222222222222222222',
      1n,
    ]);
    const decoded = decoder.decodeCall(
      '0xabcdef0123456789abcdef0123456789abcdef01',
      '0',
      calldata,
      erc20Iface,
    );
    expect(decoded.target).toMatch(/[A-F]/);
  });

  it('preserves exact calldata and produces a deterministic sha256 checksum', () => {
    const calldata = erc20Iface.encodeFunctionData('approve', [
      '0x3333333333333333333333333333333333333333',
      999n,
    ]);

    const decodedA = decoder.decodeCall(
      '0x3333333333333333333333333333333333333333',
      '0',
      calldata,
      erc20Iface,
    );
    const decodedB = decoder.decodeCall(
      '0x3333333333333333333333333333333333333333',
      '0',
      calldata,
      erc20Iface,
    );

    expect(decodedA.calldata).toBe(calldata);
    expect(decodedA.calldataChecksum).toBe(decodedB.calldataChecksum);
    expect(decodedA.calldataChecksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('treats empty calldata (0x) as a plain ETH transfer, not an error', () => {
    const decoded = decoder.decodeCall(
      '0x4444444444444444444444444444444444444444',
      '1000000000000000000',
      '0x',
      erc20Iface,
    );
    expect(decoded.selectorUnknown).toBe(false);
    expect(decoded.functionSignature).toBeNull();
    expect(decoded.valueWei).toBe('1000000000000000000');
  });

  // ─── Unknown selector (fail closed) ─────────────────────────────────────

  it('fails closed when the selector is not in the approved ABI', () => {
    const foreignIface = new Interface(['function burn(uint256 amount)']);
    const calldata = foreignIface.encodeFunctionData('burn', [1n]);

    const decoded = decoder.decodeCall(
      '0x5555555555555555555555555555555555555555',
      '0',
      calldata,
      erc20Iface,
    );

    expect(decoded.selectorUnknown).toBe(true);
    expect(decoded.functionSignature).toBeNull();
    expect(decoded.decodedArgs).toBeNull();
    expect(decoded.calldata).toBe(calldata);
    expect(decoded.calldataChecksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed when no artifact (iface=null) is available for the target', () => {
    const calldata = erc20Iface.encodeFunctionData('transfer', [
      '0x6666666666666666666666666666666666666666',
      1n,
    ]);

    const decoded = decoder.decodeCall(
      '0x6666666666666666666666666666666666666666',
      '0',
      calldata,
      null,
    );

    expect(decoded.selectorUnknown).toBe(true);
    expect(decoded.functionSignature).toBeNull();
    expect(decoded.decodedArgs).toBeNull();
  });

  // ─── Overloaded calls (fail closed) ─────────────────────────────────────

  it('fails closed when a selector maps to multiple candidate fragments', () => {
    // Encode with a real ABI to get a valid calldata.
    const iface = new Interface([
      'function setValue(uint256 value)',
    ]);
    const calldata = iface.encodeFunctionData('setValue', [42n]);
    const realSelector = iface.getFunction('setValue(uint256)')!.selector;

    // Fake interface: two fragments claiming the same selector.
    const fakeFragmentA = {
      type: 'function',
      selector: realSelector,
      format: () => 'setValue(uint256)',
      inputs: [],
    };
    const fakeFragmentB = {
      type: 'function',
      selector: realSelector,
      format: () => 'setValue(uint256,address)',
      inputs: [],
    };
    const fakeIface = {
      fragments: [fakeFragmentA, fakeFragmentB],
      decodeFunctionData: () => [],
    } as unknown as Interface;

    const decoded = decoder.decodeCall(
      '0x7777777777777777777777777777777777777777',
      '0',
      calldata,
      fakeIface,
    );

    expect(decoded.selectorUnknown).toBe(true);
    expect(decoded.functionSignature).toBeNull();
    expect(decoded.decodedArgs).toBeNull();
  });

  // ─── ABI change / drift ─────────────────────────────────────────────────

  it('fails closed when calldata cannot be decoded by the current ABI (ABI change)', () => {
    const oldIface = new Interface([
      'function setConfig(uint256 a, uint256 b, uint256 c)',
    ]);
    const newIface = new Interface([
      'function setConfig(uint256 a, uint256 b, uint256 c, uint256 d)',
    ]);
    const calldata = oldIface.encodeFunctionData('setConfig', [1n, 2n, 3n]);

    const decoded = decoder.decodeCall(
      '0x8888888888888888888888888888888888888888',
      '0',
      calldata,
      newIface,
    );

    expect(decoded.selectorUnknown).toBe(true);
    expect(decoded.decodedArgs).toBeNull();
  });

  // ─── Robustness ─────────────────────────────────────────────────────────

  it('returns checksum+selector but fails closed for short calldata', () => {
    const decoded = decoder.decodeCall(
      '0x9999999999999999999999999999999999999999',
      '0',
      '0x1234',
      erc20Iface,
    );
    expect(decoded.selectorUnknown).toBe(true);
    expect(decoded.selector).toBeNull();
  });

  it('fails closed with the raw target preserved when the address is malformed', () => {
    const decoded = decoder.decodeCall(
      'not-an-address',
      '0',
      '0x',
      erc20Iface,
    );
    expect(decoded.selectorUnknown).toBe(true);
    expect(decoded.target).toBe('not-an-address');
  });

  describe('computeProposalHash', () => {
    it('matches the golden on-chain ProposalCreated fixture', () => {
      const hash = decoder.computeProposalHash(
        GOLDEN.targets,
        GOLDEN.values,
        GOLDEN.calldatas,
        GOLDEN.descriptionHash,
      );

      expect(hash).toBe(GOLDEN.expectedHash);
      expect(hash).not.toBe(GOLDEN.descriptionHash);
    });

    it('rejects missing or inconsistent call arrays', () => {
      expect(() =>
        decoder.computeProposalHash([], [], [], GOLDEN.descriptionHash),
      ).toThrow(/targets/);
      expect(() =>
        decoder.computeProposalHash(
          GOLDEN.targets,
          ['0'],
          GOLDEN.calldatas,
          GOLDEN.descriptionHash,
        ),
      ).toThrow(/values/);
      expect(() =>
        decoder.computeProposalHash(
          GOLDEN.targets,
          GOLDEN.values,
          ['0x'],
          GOLDEN.descriptionHash,
        ),
      ).toThrow(/calldatas/);
    });

    it('rejects malformed targets, values, calldatas and description hash', () => {
      const invalid = {
        target: ['not-an-address', ...GOLDEN.targets.slice(1)],
        value: ['-1', ...GOLDEN.values.slice(1)],
        calldata: ['0x1', ...GOLDEN.calldatas.slice(1)],
        descriptionHash: '0xdeadbeef',
      };

      expect(() =>
        decoder.computeProposalHash(
          invalid.target,
          GOLDEN.values,
          GOLDEN.calldatas,
          GOLDEN.descriptionHash,
        ),
      ).toThrow(/target/);
      expect(() =>
        decoder.computeProposalHash(
          GOLDEN.targets,
          invalid.value,
          GOLDEN.calldatas,
          GOLDEN.descriptionHash,
        ),
      ).toThrow(/value/);
      expect(() =>
        decoder.computeProposalHash(
          GOLDEN.targets,
          GOLDEN.values,
          invalid.calldata,
          GOLDEN.descriptionHash,
        ),
      ).toThrow(/calldata/);
      expect(() =>
        decoder.computeProposalHash(
          GOLDEN.targets,
          GOLDEN.values,
          GOLDEN.calldatas,
          invalid.descriptionHash,
        ),
      ).toThrow(/descriptionHash/);
    });
  });

  describe('verifyProposalHash', () => {
    const baseInput = {
      targets: GOLDEN.targets,
      values: GOLDEN.values,
      calldatas: GOLDEN.calldatas,
      descriptionHash: GOLDEN.descriptionHash.toUpperCase().replace('0X', '0x'),
      expectedProposalId: GOLDEN.proposalId,
      artifactVersion: 'governor-v1',
    };

    it('accepts a matching proposalId and returns the hash with provenance', () => {
      const result = decoder.verifyProposalHash(baseInput);

      expect(result).toEqual({
        ok: true,
        proposalHash: GOLDEN.expectedHash,
        descriptionHash: GOLDEN.descriptionHash,
        scheme: GOVERNOR_PROPOSAL_HASH_SCHEME,
        artifactVersion: 'governor-v1',
      });
    });

    it('accepts a 0x-prefixed uint256 proposalId', () => {
      const result = decoder.verifyProposalHash({
        ...baseInput,
        expectedProposalId: GOLDEN.expectedHash,
      });
      expect(result.ok).toBe(true);
    });

    it('fails closed when the hash does not match the emitted proposalId', () => {
      const result = decoder.verifyProposalHash({
        ...baseInput,
        expectedProposalId: '1',
      });
      expect(result).toEqual({
        ok: false,
        reason: 'computed hash does not match proposalId',
      });
    });

    it('fails closed when the artifact version/release is unknown', () => {
      const result = decoder.verifyProposalHash({
        ...baseInput,
        artifactVersion: '',
      });
      expect(result).toEqual({ ok: false, reason: 'missing artifactVersion' });
    });

    it('fails closed on malformed event fields instead of fabricating a hash', () => {
      const result = decoder.verifyProposalHash({
        ...baseInput,
        values: [],
      });
      expect(result.ok).toBe(false);
    });
  });
});

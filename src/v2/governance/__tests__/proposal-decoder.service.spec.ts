import {
  AbiCoder,
  Interface,
  getBytes,
  id as keccakId,
  keccak256,
} from 'ethers';
import {
  PROPOSAL_HASH_ABI_TYPES,
  ProposalDecoderService,
} from '../proposal-decoder.service';

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
    const iface = new Interface(['function setValue(uint256 value)']);
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
    const decoded = decoder.decodeCall('not-an-address', '0', '0x', erc20Iface);
    expect(decoded.selectorUnknown).toBe(true);
    expect(decoded.target).toBe('not-an-address');
  });

  // ─── Proposal hash: raw ABI-byte keccak256 ──────────────────────────────

  const goldenFixtures = [
    {
      name: 'single empty call',
      targets: ['0x0000000000000000000000000000000000001001'],
      values: ['0'],
      calldatas: ['0x'],
      descriptionHash: '0x' + '11'.repeat(32),
      expectedHash:
        '0x63aa1ca0b06bc7fcbc00a4bc60dbc20319a06ff0fc19f1111c32080c90de98e9',
    },
    {
      name: 'two calls with calldata',
      targets: [
        '0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222',
      ],
      values: ['0', '1000000000000000000'],
      calldatas: ['0xa9059cbb', '0xdeadbeef01020304'],
      descriptionHash: '0x' + 'ab'.repeat(32),
      expectedHash:
        '0x320d589c6aa6fb000362cbdccfd25f4e10c15d7a3bf2a02c2ae96cfc5a3e06e6',
    },
  ] as const;

  const hashOf = (fixture: (typeof goldenFixtures)[number]) =>
    decoder.computeProposalHash(
      [...fixture.targets],
      [...fixture.values],
      [...fixture.calldatas],
      fixture.descriptionHash,
    );

  it('uses the Governor ABI field order of the approved release', () => {
    expect(PROPOSAL_HASH_ABI_TYPES).toEqual([
      'address[]',
      'uint256[]',
      'bytes[]',
      'bytes32',
    ]);
  });

  it.each(goldenFixtures)(
    'matches the golden ProposalCreated hash for $name',
    (fixture) => {
      expect(hashOf(fixture)).toBe(fixture.expectedHash);
    },
  );

  it('produces distinct hashes for distinct proposals', () => {
    expect(hashOf(goldenFixtures[0])).not.toBe(hashOf(goldenFixtures[1]));
    expect(goldenFixtures[0].expectedHash).not.toBe(
      goldenFixtures[1].expectedHash,
    );
  });

  it('changes the hash when any ABI-encoded field is mutated', () => {
    const base = goldenFixtures[0];
    const baseline = hashOf(base);
    expect(
      decoder.computeProposalHash(
        ['0x0000000000000000000000000000000000001002'],
        [...base.values],
        [...base.calldatas],
        base.descriptionHash,
      ),
    ).not.toBe(baseline);
    expect(
      decoder.computeProposalHash(
        [...base.targets],
        ['1'],
        [...base.calldatas],
        base.descriptionHash,
      ),
    ).not.toBe(baseline);
    expect(
      decoder.computeProposalHash(
        [...base.targets],
        [...base.values],
        ['0x00'],
        base.descriptionHash,
      ),
    ).not.toBe(baseline);
    expect(
      decoder.computeProposalHash(
        [...base.targets],
        [...base.values],
        [...base.calldatas],
        '0x' + '22'.repeat(32),
      ),
    ).not.toBe(baseline);
  });

  it('hashes raw ABI bytes, not the UTF-8 hex string (no id() regression)', () => {
    const fixture = goldenFixtures[0];
    const encoded = AbiCoder.defaultAbiCoder().encode(
      [...PROPOSAL_HASH_ABI_TYPES],
      [
        [...fixture.targets],
        [...fixture.values],
        [...fixture.calldatas],
        fixture.descriptionHash,
      ],
    );
    expect(keccak256(getBytes(encoded))).toBe(fixture.expectedHash);
    expect(keccakId(encoded)).not.toBe(fixture.expectedHash);
    expect(keccakId(encoded)).toBe(
      '0x55e0cd995771602a731d858ccf67a84e314be91c4e5dfce74fe0a171e8a4ad67',
    );
  });

  const invalidInputs: Array<{
    name: string;
    args: [string[], string[], string[], string];
    message: RegExp;
  }> = [
    {
      name: 'invalid address',
      args: [['not-an-address'], ['0'], ['0x'], '0x' + '11'.repeat(32)],
      message: /target at index 0 is not a valid address/,
    },
    {
      name: 'invalid mixed-case address checksum',
      args: [
        ['0xAbCDEF0123456789abcdef0123456789abcdef01'],
        ['0'],
        ['0x'],
        '0x' + '11'.repeat(32),
      ],
      message: /invalid EIP-55 checksum/,
    },
    {
      name: 'mismatched array lengths',
      args: [
        ['0x0000000000000000000000000000000000001001'],
        ['0', '1'],
        ['0x'],
        '0x' + '11'.repeat(32),
      ],
      message: /input length mismatch/,
    },
    {
      name: 'empty call list',
      args: [[], [], [], '0x' + '11'.repeat(32)],
      message: /at least one call/,
    },
    {
      name: 'negative uint256',
      args: [
        ['0x0000000000000000000000000000000000001001'],
        ['-1'],
        ['0x'],
        '0x' + '11'.repeat(32),
      ],
      message: /not a non-negative decimal uint256/,
    },
    {
      name: 'non-integer uint256',
      args: [
        ['0x0000000000000000000000000000000000001001'],
        ['1.5'],
        ['0x'],
        '0x' + '11'.repeat(32),
      ],
      message: /not a non-negative decimal uint256/,
    },
    {
      name: 'uint256 overflow',
      args: [
        ['0x0000000000000000000000000000000000001001'],
        [(2n ** 256n).toString()],
        ['0x'],
        '0x' + '11'.repeat(32),
      ],
      message: /exceeds uint256 range/,
    },
    {
      name: 'malformed calldata hex',
      args: [
        ['0x0000000000000000000000000000000000001001'],
        ['0'],
        ['0xzz'],
        '0x' + '11'.repeat(32),
      ],
      message: /not valid 0x-prefixed hex bytes/,
    },
    {
      name: 'odd-length calldata hex',
      args: [
        ['0x0000000000000000000000000000000000001001'],
        ['0'],
        ['0xabc'],
        '0x' + '11'.repeat(32),
      ],
      message: /not valid 0x-prefixed hex bytes/,
    },
    {
      name: 'malformed description hash',
      args: [
        ['0x0000000000000000000000000000000000001001'],
        ['0'],
        ['0x'],
        '0xdeadbeef',
      ],
      message: /descriptionHash must be a 0x-prefixed bytes32 value/,
    },
  ];

  it.each(invalidInputs)(
    'rejects $name before hashing',
    ({ args, message }) => {
      expect(() => decoder.computeProposalHash(...args)).toThrow(message);
    },
  );

  // ─── Non-authoritative cross-check with release provenance ──────────────

  const provenance = {
    chainId: 11155420,
    releaseId: 'rel-opsepolia-20261015-v2',
    deploymentBlock: 24850000,
    artifactChecksum: '0x' + 'a1'.repeat(32),
    governorAddress: '0x0000000000000000000000000000000000001005',
    transactionHash: '0x' + 'bc'.repeat(32),
    logIndex: 3,
    blockNumber: 24850042,
  };

  it('returns a matching, explicitly non-authoritative cross-check with provenance', () => {
    const fixture = goldenFixtures[0];
    const result = decoder.crossCheckProposalHash(
      {
        targets: [...fixture.targets],
        values: [...fixture.values],
        calldatas: [...fixture.calldatas],
        descriptionHash: fixture.descriptionHash,
      },
      fixture.expectedHash,
      provenance,
    );
    expect(result.matches).toBe(true);
    expect(result.authoritative).toBe(false);
    expect(result.computedHash).toBe(fixture.expectedHash);
    expect(result.abiTypes).toEqual([...PROPOSAL_HASH_ABI_TYPES]);
    expect(result.provenance).toEqual(provenance);
  });

  it('reports a mismatch without treating the computed hash as state', () => {
    const fixture = goldenFixtures[1];
    const result = decoder.crossCheckProposalHash(
      {
        targets: [...fixture.targets],
        values: [...fixture.values],
        calldatas: [...fixture.calldatas],
        descriptionHash: fixture.descriptionHash,
      },
      goldenFixtures[0].expectedHash,
      provenance,
    );
    expect(result.matches).toBe(false);
    expect(result.authoritative).toBe(false);
    expect(result.observedHash).toBe(goldenFixtures[0].expectedHash);
  });

  it('rejects cross-checks with incomplete provenance or malformed observed hash', () => {
    const fixture = goldenFixtures[0];
    const input = {
      targets: [...fixture.targets],
      values: [...fixture.values],
      calldatas: [...fixture.calldatas],
      descriptionHash: fixture.descriptionHash,
    };
    expect(() =>
      decoder.crossCheckProposalHash(input, '0x1234', provenance),
    ).toThrow(/observed proposal hash must be a 0x-prefixed bytes32 value/i);
    expect(() =>
      decoder.crossCheckProposalHash(input, fixture.expectedHash, {
        ...provenance,
        chainId: 1,
      }),
    ).toThrow(/not an approved Optimism chain/);
    expect(() =>
      decoder.crossCheckProposalHash(input, fixture.expectedHash, {
        ...provenance,
        artifactChecksum: '0xdeadbeef',
      }),
    ).toThrow(/requires complete release provenance/);
  });
});

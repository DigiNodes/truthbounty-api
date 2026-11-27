import { Interface } from 'ethers';
import { ProposalDecoderService } from './proposal-decoder.service';

describe('ProposalDecoderService', () => {
  const TARGET = '0x0000000000000000000000000000000000000001';
  const VALUE = '0';

  const iface = new Interface([
    'function transfer(address to, uint256 amount)',
    'function approve(address spender, uint256 amount)',
  ]);

  const service = new ProposalDecoderService();

  function encodeTransfer(to: string, amount: bigint): string {
    return iface.encodeFunctionData('transfer', [to, amount]);
  }

  it('returns a plain transfer for empty calldata', () => {
    const result = service.decodeCall(TARGET, VALUE, '0x', iface);
    expect(result.selectorUnknown).toBe(false);
    expect(result.selector).toBeNull();
    expect(result.functionSignature).toBeNull();
    expect(result.decodedArgs).toBeNull();
    expect(result.calldata).toBe('0x');
  });

  it('decodes a valid selector and ABI payload', () => {
    const to = '0x000000000000000000000000000000000000002';
    const calldata = encodeTransfer(to, 1_000n);
    const result = service.decodeCall(TARGET, VALUE, calldata, iface);
    expect(result.selectorUnknown).toBe(false);
    expect(result.functionSignature).toBe(iface.getFunction('transfer')!.format('sighash'));
    expect(result.decodedArgs).toEqual({ to, amount: '1000' });
    expect(result.calldata).toBe(calldata);
  });

  it('returns unknown for a short selector without throwing', () => {
    const result = service.decodeCall(TARGET, VALUE, '0x1234', iface);
    expect(result.selectorUnknown).toBe(true);
    expect(result.selector).toBeNull();
    expect(result.decodedArgs).toBeNull();
  });

  it('returns unknown for odd-length calldata', () => {
    const result = service.decodeCall(TARGET, VALUE, '0x123', iface);
    expect(result.selectorUnknown).toBe(true);
    expect(result.selector).toBeNull();
    expect(result.decodedArgs).toBeNull();
  });

  it('returns unknown for non-hex calldata', () => {
    const result = service.decodeCall(TARGET, VALUE, '0xzz123456', iface);
    expect(result.selectorUnknown).toBe(true);
    expect(result.selector).toBeNull();
    expect(result.decodedArgs).toBeNull();
  });

  it('returns unknown for calldata missing the 0x prefix', () => {
    const result = service.decodeCall(TARGET, VALUE, '12345678', iface);
    expect(result.selectorUnknown).toBe(true);
    expect(result.selector).toBeNull();
    expect(result.decodedArgs).toBeNull();
  });

  it('returns unknown for oversized calldata', () => {
    const bytes = ProposalDecoderService.MAX_CALLDATA_BYTES + 1;
    const calldata = '0x' + '00'.repeat(bytes);
    const result = service.decodeCall(TARGET, VALUE, calldata, iface);
    expect(result.selectorUnknown).toBe(true);
    expect(result.selector).toBeNull();
    expect(result.decodedArgs).toBeNull();
  });

  it('returns unknown for malformed ABI arguments without throwing', () => {
    const selector = iface.getFunction('transfer')!.selector;
    // Selector + truncated payload (abi decode will fail).
    const calldata = selector + '0000000000000000';
    const result = service.decodeCall(TARGET, VALUE, calldata, iface);
    expect(result.selectorUnknown).toBe(true);
    expect(result.selector).toBe(selector);
    expect(result.decodedArgs).toBeNull();
  });

  it('handles a proposal with one malformed call alongside valid calls', () => {
    const to = '0x0000000000000000000000000000000000000002';
    const validCalldata = encodeTransfer(to, 5_000n);
    const calls = [
      { target: TARGET, value: '0', calldata: validCalldata },
      { target: TARGET, value: '0', calldata: '0xzz' },
      { target: TARGET, value: '0', calldata: '0x' },
    ];

    const decoded = calls.map((c) => service.decodeCall(c.target, c.value, c.calldata, iface));

    expect(decoded[0].selectorUnknown).toBe(false);
    expect(decoded[0].decodedArgs).toEqual({ to, amount: '5000' });
    expect(decoded[1].selectorUnknown).toBe(true);
    expect(decoded[1].decodedArgs).toBeNull();
    expect(decoded[2].selectorUnknown).toBe(false);
    expect(decoded[2].decodedArgs).toBeNull();
  });

  it('preserves the raw calldata and checksum for valid input', () => {
    const to = '0x0000000000000000000000000000000000000002';
    const calldata = encodeTransfer(to, 7_000n);
    const result = service.decodeCall(TARGET, VALUE, calldata, iface);
    expect(result.calldata).toBe(calldata);
    expect(result.calldataChecksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

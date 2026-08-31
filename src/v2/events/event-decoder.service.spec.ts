import { Interface, id as topicId, AbiCoder } from 'ethers';
import { EventDecoderService } from './event-decoder.service';
import { RawLog } from './interfaces/canonical-event.interface';

const ABI = [
  'event EvidenceRegistered(bytes32 indexed claimId, address indexed submitter, bytes32 digest)',
  'event SomeFutureEvent(bytes32 indexed claimId, uint256 value)',
];

function baseLog(overrides: Partial<RawLog> = {}): RawLog {
  return {
    chainId: 10,
    address: '0xabc0000000000000000000000000000000000a',
    topics: [],
    data: '0x',
    transactionHash: '0x' + '11'.repeat(32),
    logIndex: 0,
    blockNumber: 100n,
    ...overrides,
  };
}

describe('EventDecoderService', () => {
  let service: EventDecoderService;
  let iface: Interface;

  beforeEach(() => {
    service = new EventDecoderService();
    iface = new Interface(ABI);
  });

  function encodeEvidenceRegistered(
    claimId: string,
    submitter: string,
    digest: string,
  ): RawLog {
    const fragment = iface.getEvent('EvidenceRegistered')!;
    const topics = iface.encodeFilterTopics(fragment, [claimId, submitter]);
    const data = AbiCoder.defaultAbiCoder().encode(['bytes32'], [digest]);
    return baseLog({ topics: topics as string[], data });
  }

  it('decodes and normalizes a known event on the success path', () => {
    const claimId = '0x' + '22'.repeat(32);
    const submitter = '0x' + '33'.repeat(20);
    const digest = '0x' + '44'.repeat(32);
    const log = encodeEvidenceRegistered(claimId, submitter, digest);

    const decoded = service.decode(log, iface);
    expect(decoded.status).toBe('decoded');
    if (decoded.status !== 'decoded') throw new Error('unreachable');

    const normalized = service.normalize(log, 'v1', decoded.description);
    expect(normalized.status).toBe('normalized');
    if (normalized.status !== 'normalized') throw new Error('unreachable');

    expect(normalized.event.eventName).toBe('EvidenceRegistered');
    expect(normalized.event.claimId).toBe(claimId);
    expect(normalized.event.actor).toBe(submitter.toLowerCase());
    expect(normalized.event.contractAddress).toBe(log.address.toLowerCase());
    expect(normalized.event.payload.digest).toBe(digest);
  });

  it('reports unknown_signature for a topic0 the ABI does not contain at all', () => {
    const log = baseLog({ topics: ['0x' + 'ff'.repeat(32)], data: '0x' });
    const decoded = service.decode(log, iface);
    expect(decoded.status).toBe('unknown_signature');
  });

  it('reports decode_error when topic0 matches but data is malformed', () => {
    const fragment = iface.getEvent('EvidenceRegistered')!;
    const claimId = '0x' + '22'.repeat(32);
    const submitter = '0x' + '33'.repeat(20);
    const topics = iface.encodeFilterTopics(fragment, [
      claimId,
      submitter,
    ]) as string[];
    const log = baseLog({ topics, data: '0x1234' }); // too short to decode the bytes32 digest

    const decoded = service.decode(log, iface);
    expect(decoded.status).toBe('decode_error');
  });

  it('flags artifact_drift when the ABI decodes an event with no canonical schema mapping', () => {
    const fragment = iface.getEvent('SomeFutureEvent')!;
    const claimId = '0x' + '22'.repeat(32);
    const topics = iface.encodeFilterTopics(fragment, [claimId]) as string[];
    const data = AbiCoder.defaultAbiCoder().encode(['uint256'], [42n]);
    const log = baseLog({ topics, data });

    const decoded = service.decode(log, iface);
    expect(decoded.status).toBe('decoded');
    if (decoded.status !== 'decoded') throw new Error('unreachable');

    const normalized = service.normalize(log, 'v1', decoded.description);
    expect(normalized.status).toBe('artifact_drift');
  });

  it('serializes bigint args in the payload as decimal strings, never as JS numbers', () => {
    const abi = ['event AmountEmitted(uint256 amount)'];
    const localIface = new Interface(abi);
    const fragment = localIface.getEvent('AmountEmitted')!;
    const topics = localIface.encodeFilterTopics(fragment, []) as string[];
    const data = AbiCoder.defaultAbiCoder().encode(
      ['uint256'],
      [123456789012345678901234567890n],
    );
    const log = baseLog({ topics, data });

    const decoded = service.decode(log, localIface);
    expect(decoded.status).toBe('decoded');
    if (decoded.status !== 'decoded') throw new Error('unreachable');

    expect(typeof decoded.description.args[0]).toBe('bigint');
  });

  it('reports the topic0 that failed lookup so quarantine records remain investigable', () => {
    const badTopic = topicId('NotAnEvent(uint256)');
    const log = baseLog({ topics: [badTopic], data: '0x' });
    const decoded = service.decode(log, iface);
    expect(decoded.status).toBe('unknown_signature');
  });
});

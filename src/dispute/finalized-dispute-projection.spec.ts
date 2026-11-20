import {
  DisputeEvent,
  DisputeRelease,
  replayDisputes,
} from './finalized-dispute-projection';

export const hash = (digit: string) => `0x${digit.repeat(64)}`;
export const release: DisputeRelease = {
  chainId: 10,
  releaseId: 'release-a',
  contractAddress: `0x${'a'.repeat(40)}`,
  deploymentBlock: 10n,
  decoderVersion: 'approved-v1',
};
export const event = (
  name = 'DisputeRaised',
  overrides: Partial<DisputeEvent> = {},
): DisputeEvent => ({
  ...release,
  eventName: name,
  blockNumber: name === 'DisputeRaised' ? '10' : '11',
  blockHash: name === 'DisputeRaised' ? hash('1') : hash('2'),
  txHash: hash('3'),
  logIndex: name === 'DisputeRaised' ? 0 : 1,
  removed: false,
  payload: JSON.stringify({
    claimId: 'claim-1',
    roundId: 'round-1',
    outcome: 'OVERTURNED',
    finalConfidence: 0.9,
  }),
  ...overrides,
});
const hashes = new Map([
  ['10', hash('1')],
  ['11', hash('2')],
]);

describe('finalized dispute replay', () => {
  it('projects exact provenance and only canonical confidence/outcome', () => {
    const [view] = replayDisputes(
      [event('DisputeResolved'), event()],
      release,
      11n,
      hashes,
    );
    expect(view.status).toBe('RESOLVED');
    expect(view.finalConfidence).toBe(0.9);
    expect(view.originalConfidence).toBeNull();
    expect(view.outcome).toBe('OVERTURNED');
    expect(view.provenance[1]).toEqual({
      chainId: 10,
      releaseId: 'release-a',
      contractAddress: release.contractAddress,
      deploymentBlock: '10',
      decoderVersion: 'approved-v1',
      blockNumber: '11',
      blockHash: hash('2'),
      transactionHash: hash('3'),
      logIndex: 1,
    });
  });

  it.each([
    { chainId: 11155420 },
    { releaseId: 'other' },
    { contractAddress: `0x${'b'.repeat(40)}` },
    { decoderVersion: 'unapproved' },
    { removed: true },
    { blockNumber: '9' },
  ])('ignores unsupported source %j', (override) => {
    expect(
      replayDisputes(
        [event('DisputeResolved', override)],
        release,
        11n,
        hashes,
      ),
    ).toEqual([]);
  });

  it('does not publish unfinalized outcomes', () => {
    expect(
      replayDisputes(
        [event(), event('DisputeResolved')],
        release,
        10n,
        hashes,
      )[0].status,
    ).toBe('OPEN');
  });

  it('deduplicates replay, deterministically rebuilds, and rolls back a reorged terminal event', () => {
    const history = [event(), event('DisputeResolved')];
    const before = replayDisputes(history, release, 11n, hashes);
    expect(
      replayDisputes([...history, ...history].reverse(), release, 11n, hashes),
    ).toEqual(before);
    const fork = new Map(hashes).set('11', hash('4'));
    expect(replayDisputes(history, release, 11n, fork)[0].outcome).toBeNull();
    expect(replayDisputes(history, release, 11n, fork)[0].status).toBe('OPEN');
    const replacement = event('DisputeExpired', {
      blockHash: hash('4'),
      payload: JSON.stringify({ claimId: 'claim-1', roundId: 'round-1' }),
    });
    const [after] = replayDisputes(
      [...history, replacement],
      release,
      11n,
      fork,
    );
    expect(after.status).toBe('EXPIRED');
    expect(after.bond.disposition).toBeNull();
    expect(after.settlement).toBeNull();
    expect(replayDisputes([event(), replacement], release, 11n, fork)).toEqual([
      after,
    ]);
  });

  it('fails closed on incomplete history, conflicting duplicates, and malformed payloads', () => {
    expect(() =>
      replayDisputes([event('DisputeResolved')], release, 11n, hashes),
    ).toThrow('transition');
    expect(() =>
      replayDisputes(
        [event(), event('DisputeRaised', { payload: '{}' })],
        release,
        11n,
        hashes,
      ),
    ).toThrow('duplicate');
    expect(() =>
      replayDisputes(
        [event('DisputeRaised', { payload: 'broken' })],
        release,
        11n,
        hashes,
      ),
    ).toThrow();
  });
});

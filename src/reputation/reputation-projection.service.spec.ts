import {
  ReputationProjectionAuthority,
  ReputationProjectionCompleteness,
  ReputationProjectionEvent,
  ReputationProjectionService,
} from './reputation-projection.service';

const hash = (digit: string) => `0x${digit.repeat(64)}`;
const blockHashFor = (blockNumber: number) =>
  `0x${blockNumber.toString(16).padStart(64, '0')}`;
const address = `0x${'a'.repeat(40)}`;

const authority: ReputationProjectionAuthority = {
  chainId: 10,
  releaseId: 'release-7',
  artifactHash: hash('a'),
  contractAddress: address,
  finalizedThroughBlock: 500,
  finalizedBlockHash: hash('f'),
};

const completeness: ReputationProjectionCompleteness = {
  throughBlock: 500,
  blockHash: hash('f'),
  isComplete: true,
};

const adjustment = (
  blockNumber: number,
  logIndex: number,
  deltaUnits: string,
  extra: Partial<ReputationProjectionEvent> = {},
): ReputationProjectionEvent =>
  ({
    chainId: authority.chainId,
    releaseId: authority.releaseId,
    artifactHash: authority.artifactHash,
    contractAddress: authority.contractAddress,
    blockNumber,
    blockHash:
      blockNumber === authority.finalizedThroughBlock
        ? authority.finalizedBlockHash
        : blockHashFor(blockNumber),
    transactionHash: hash(((logIndex % 10) + 1).toString()),
    transactionIndex: logIndex,
    logIndex,
    userId: 'user-1',
    isCanonical: true,
    isFinalized: true,
    kind: 'adjustment',
    deltaUnits,
    ...extra,
  }) as ReputationProjectionEvent;

const decay = (
  blockNumber: number,
  logIndex: number,
  numerator: string,
  denominator: string,
  extra: Partial<ReputationProjectionEvent> = {},
): ReputationProjectionEvent =>
  ({
    ...adjustment(blockNumber, logIndex, '0'),
    kind: 'decay_checkpoint',
    numerator,
    denominator,
    ...extra,
  }) as ReputationProjectionEvent;

describe('ReputationProjectionService', () => {
  it('orders out-of-order events by block, transaction, and log position', () => {
    const service = new ReputationProjectionService(authority);
    const snapshot = service.rebuild(
      [adjustment(12, 2, '7'), adjustment(11, 3, '10'), decay(12, 1, '1', '2')],
      authority,
      completeness,
    );

    expect(snapshot.values['user-1']).toBe('12');
    expect(snapshot.decayCheckpoints[0].priorUnits).toBe('10');
    expect(snapshot.decayCheckpoints[0].projectedUnits).toBe('5');
  });

  it('ignores identical duplicate events and rejects conflicting log duplicates', () => {
    const service = new ReputationProjectionService(authority);
    const event = adjustment(20, 0, '99');
    const snapshot = service.rebuild(
      [event, { ...event }],
      authority,
      completeness,
    );

    expect(snapshot.eventCount).toBe(1);
    expect(snapshot.values['user-1']).toBe('99');
    expect(() =>
      service.rebuild(
        [event, adjustment(20, 0, '100')],
        authority,
        completeness,
      ),
    ).toThrow('Conflicting duplicate reputation event');
  });

  it('uses same-block contract ordering for decay and adjustments', () => {
    const service = new ReputationProjectionService(authority);
    const snapshot = service.rebuild(
      [
        adjustment(30, 0, '9', { transactionIndex: 1 }),
        decay(30, 5, '1', '2', { transactionIndex: 0 }),
        adjustment(30, 2, '2', { transactionIndex: 1 }),
      ],
      authority,
      completeness,
    );

    expect(snapshot.values['user-1']).toBe('11');
  });

  it('restores the prior value when an orphaned block is rolled back', () => {
    const service = new ReputationProjectionService(authority);
    service.rebuild(
      [adjustment(40, 0, '25'), adjustment(41, 0, '-8')],
      authority,
      completeness,
    );
    const snapshot = service.rollback(
      [blockHashFor(41)],
      authority,
      completeness,
    );

    expect(snapshot.values['user-1']).toBe('25');
    expect(snapshot.eventCount).toBe(1);
  });

  it('applies long decay sequences with exact integer units', () => {
    const events: ReputationProjectionEvent[] = [
      adjustment(1, 0, '900719925474099312345'),
    ];
    for (let blockNumber = 2; blockNumber <= 101; blockNumber++) {
      events.push(decay(blockNumber, 0, '999', '1000'));
    }
    const snapshot = new ReputationProjectionService(authority).rebuild(
      events,
      authority,
      completeness,
    );

    expect(snapshot.values['user-1']).toBe('814964315317810309523');
    expect(snapshot.decayCheckpoints).toHaveLength(100);
    expect(snapshot.decayCheckpoints[99]).toMatchObject({
      chainId: authority.chainId,
      releaseId: authority.releaseId,
      artifactHash: authority.artifactHash,
      contractAddress: authority.contractAddress,
      blockHash: blockHashFor(101),
    });
  });

  it('produces the same full rebuild digest as live out-of-order projection', () => {
    const events = [
      adjustment(61, 0, '100000000000000000001'),
      decay(62, 0, '3', '4'),
      adjustment(63, 0, '-17'),
    ];
    const live = new ReputationProjectionService(authority);
    live.applyFinalizedEvents([events[2], events[0]], completeness);
    const liveSnapshot = live.applyFinalizedEvents([events[1]], completeness);
    const rebuiltSnapshot = new ReputationProjectionService(authority).rebuild(
      [...events].reverse(),
      authority,
      completeness,
    );
    const sameValueDifferentHistory = new ReputationProjectionService(
      authority,
    ).rebuild(
      [adjustment(61, 0, '100000000000000000000'), events[1], events[2]],
      authority,
      completeness,
    );

    expect(liveSnapshot).toEqual(rebuiltSnapshot);
    expect(sameValueDifferentHistory.values).toEqual(liveSnapshot.values);
    expect(sameValueDifferentHistory.digest).not.toBe(liveSnapshot.digest);
  });

  it('fails closed for incomplete, stale, unauthorized, or unfinalized inputs', () => {
    const service = new ReputationProjectionService(authority);
    expect(() =>
      service.rebuild([], authority, { ...completeness, isComplete: false }),
    ).toThrow('incomplete or stale');
    expect(() =>
      service.rebuild([], authority, { ...completeness, throughBlock: 499 }),
    ).toThrow('incomplete or stale');
    expect(() =>
      service.rebuild(
        [adjustment(70, 0, '1', { releaseId: 'unapproved-release' })],
        authority,
        completeness,
      ),
    ).toThrow('Unauthorized reputation event provenance');
    expect(() =>
      service.rebuild(
        [adjustment(70, 0, '1', { isFinalized: false })],
        authority,
        completeness,
      ),
    ).toThrow('finalized canonical range');
    expect(() =>
      service.rebuild(
        [
          adjustment(70, 0, '1'),
          adjustment(70, 1, '1', { blockHash: hash('e') }),
        ],
        authority,
        completeness,
      ),
    ).toThrow('Ambiguous canonical block hash');
  });
});

import { canonicalProjectionChange } from './projection-payload';
import { ProjectionEventType } from './realtime.enums';

describe('canonicalProjectionChange', () => {
  it('always carries the REST row identity so WS and REST consumers see the same row', () => {
    const change = canonicalProjectionChange({
      aggregateType: 'verification.round',
      aggregateId: 'round-1',
      eventType: ProjectionEventType.CREATED,
      coordinate: {
        id: 'round-1',
        blockNumber: '100',
        eventLogIndex: 2,
        eventTxHash: '0xabc',
        dataState: 'finalized',
      },
      fields: {
        claimId: '0xclaim',
        roundType: 'first',
      },
      correlationId: '0xabc',
    });

    expect(change).toEqual({
      aggregateType: 'verification.round',
      aggregateId: 'round-1',
      eventType: ProjectionEventType.CREATED,
      finalized: false,
      correlationId: '0xabc',
      payload: {
        id: 'round-1',
        blockNumber: '100',
        eventLogIndex: 2,
        eventTxHash: '0xabc',
        dataState: 'finalized',
        claimId: '0xclaim',
        roundType: 'first',
      },
    });
  });

  it('normalizes numeric chain coordinates to the same string form REST exposes', () => {
    const change = canonicalProjectionChange({
      aggregateType: 'evidence',
      aggregateId: 'claim-1',
      eventType: ProjectionEventType.UPDATED,
      coordinate: {
        id: 'claim-1',
        blockNumber: 123, // sqlite returns numbers for bigint columns
        eventLogIndex: 0,
        eventTxHash: '0x',
      },
      fields: { status: 'active' },
    });

    expect(change.payload.blockNumber).toBe('123');
  });

  it('never lets domain fields shadow the row identity/coordinate keys', () => {
    const change = canonicalProjectionChange({
      aggregateType: 'dispute',
      aggregateId: 'd-1',
      eventType: ProjectionEventType.UPDATED,
      coordinate: {
        id: 'd-1',
        blockNumber: '55',
        eventLogIndex: 9,
        eventTxHash: '0xcoordinate',
      },
      // Hostile/duplicated keys in domain fields must not override identity.
      fields: {
        id: 'spoofed',
        blockNumber: '1',
        eventLogIndex: 1,
        eventTxHash: '0xspoofed',
      },
    });

    expect(change.payload).toMatchObject({
      id: 'd-1',
      blockNumber: '55',
      eventLogIndex: 9,
      eventTxHash: '0xcoordinate',
    });
  });

  it('defaults finalized and omits dataState when not provided', () => {
    const change = canonicalProjectionChange({
      aggregateType: 'dispute',
      aggregateId: 'd-2',
      eventType: ProjectionEventType.CREATED,
      coordinate: {
        id: 'd-2',
        blockNumber: '10',
        eventLogIndex: 0,
        eventTxHash: '0x',
      },
      fields: { status: 'raised' },
    });

    expect(change.finalized).toBe(false);
    expect(change.payload.dataState).toBeUndefined();
    expect(change.payload.status).toBe('raised');
  });
});
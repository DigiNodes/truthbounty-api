import {
  toDisputeLifecycleView,
  DisputeLifecycleView,
} from './dispute-lifecycle';
import { DisputeStatus, ProjectDispute } from './entities/project-dispute.entity';
import { DataState } from '../common/data-state.enum';

function makeDispute(
  over: Partial<ProjectDispute> = {},
): ProjectDispute {
  return {
    disputeId: 'claim-1:round-1',
    claimId: 'claim-1',
    originalRoundId: 'round-1',
    appealRoundId: 'appeal-1',
    challengeBond: '1000',
    challengeBondAsset: '0xtoken',
    status: DisputeStatus.RAISED,
    deadline: new Date('2026-10-20T00:00:00.000Z'),
    resolvedOutcome: null,
    dataState: DataState.OBSERVED,
    eventTxHash:
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    eventLogIndex: 0,
    blockNumber: '100',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ProjectDispute;
}

describe('toDisputeLifecycleView (#660)', () => {
  const now = new Date('2026-10-15T00:00:00.000Z');

  it('provisional is never serialized as final', () => {
    const view = toDisputeLifecycleView(
      makeDispute({ resolvedOutcome: null }),
      DataState.FINALIZED, // chain finalized ≠ dispute final
      { now, provisionalOutcome: 'support' },
    );
    expect(view.phase).not.toBe('finalized');
    expect(view.final).toBeNull();
    expect(view.provisional?.outcome).toBe('support');
    expect(view.chainDataState).toBe(DataState.FINALIZED);
  });

  it('tie-style provisional outcome stays under provisional only', () => {
    const view = toDisputeLifecycleView(makeDispute(), DataState.SAFE, {
      now,
      provisionalOutcome: 'tie',
    });
    expect(view.provisional?.outcome).toBe('tie');
    expect(view.final).toBeNull();
  });

  it('expiry finalizes with refund-only bond disposition', () => {
    const view = toDisputeLifecycleView(
      makeDispute({ status: DisputeStatus.EXPIRED, resolvedOutcome: null }),
      DataState.SAFE,
      { now },
    );
    expect(view.phase).toBe('finalized');
    expect(view.final).toEqual({ status: 'expired', outcome: null });
    expect(view.provisional).toBeNull();
    expect(view.bond.disposition).toBe('refunded');
    expect(view.appeal.available).toBe(false);
    expect(view.appeal.reason).toBe('already_final');
  });

  it('appeal availability is contract-derived from deadline window', () => {
    const open = toDisputeLifecycleView(makeDispute(), DataState.OBSERVED, {
      now: new Date('2026-10-15T00:00:00.000Z'),
    });
    expect(open.appeal.available).toBe(true);
    expect(open.phase).toBe('appealable');
    expect(open.appeal.reason).toBe('window_open');

    const closed = toDisputeLifecycleView(makeDispute(), DataState.OBSERVED, {
      now: new Date('2026-10-21T00:00:00.000Z'),
    });
    expect(closed.appeal.available).toBe(false);
    expect(closed.appeal.reason).toBe('deadline_passed');
    expect(closed.phase).toBe('provisional');
  });

  it('max round blocks appeal', () => {
    const view = toDisputeLifecycleView(
      makeDispute({ originalRoundId: 'round-3' }),
      DataState.OBSERVED,
      { now, maxAppealRound: 3 },
    );
    expect(view.appeal.available).toBe(false);
    expect(view.appeal.reason).toBe('max_round');
  });

  it('resolved outcome is only in final', () => {
    const view = toDisputeLifecycleView(
      makeDispute({
        status: DisputeStatus.RESOLVED,
        resolvedOutcome: 'challenger_wins',
      }),
      DataState.FINALIZED,
      { now, terminalBondDisposition: 'slashed' },
    );
    expect(view.phase).toBe('finalized');
    expect(view.final?.outcome).toBe('challenger_wins');
    expect(view.provisional).toBeNull();
    expect(view.bond.disposition).toBe('slashed');
  });

  it('reorg-safe: same event identity remains the timeline ref after later clock', () => {
    const d = makeDispute({ blockNumber: '100', eventLogIndex: 2 });
    const first = toDisputeLifecycleView(d, DataState.OBSERVED, { now });
    const later = toDisputeLifecycleView(d, DataState.SAFE, {
      now: new Date(now.getTime() + 60_000),
    });
    expect(later.timeline).toEqual(first.timeline);
    expect(later.timeline[0].txHash).toBe(d.eventTxHash);
    expect(later.timeline[0].logIndex).toBe(2);
  });

  it('duplicate settlement does not invent a second final outcome', () => {
    const d = makeDispute({
      status: DisputeStatus.RESOLVED,
      resolvedOutcome: 'defender_wins',
    });
    const a = toDisputeLifecycleView(d, DataState.FINALIZED, { now });
    const b = toDisputeLifecycleView(d, DataState.FINALIZED, { now });
    expect(a.final).toEqual(b.final);
    expect(a.final?.outcome).toBe('defender_wins');
  });

  it('rebuild: view is pure function of projected row + chain state', () => {
    const d = makeDispute();
    const a = toDisputeLifecycleView(d, DataState.SAFE, {
      now,
      provisionalOutcome: 'support',
    });
    const b = toDisputeLifecycleView(d, DataState.SAFE, {
      now,
      provisionalOutcome: 'support',
    });
    expect(a).toEqual(b);
  });

  it('bond amount/asset are exact projections', () => {
    const view = toDisputeLifecycleView(
      makeDispute({ challengeBond: '999', challengeBondAsset: '0xabc' }),
      DataState.OBSERVED,
      { now },
    );
    expect(view.bond.amount).toBe('999');
    expect(view.bond.asset).toBe('0xabc');
    expect(view.bond.disposition).toBe('locked');
  });
});

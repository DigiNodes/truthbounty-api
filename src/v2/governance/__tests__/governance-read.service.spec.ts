import { GovernanceReadService } from '../governance-read.service';
import { ProposalChainState } from '../entities/governance-proposal.entity';

/**
 * PREWAVE-BE-190 (#891) golden tests: the timelock read model must be built
 * exclusively from immutable canonical lifecycle transitions, not from the
 * proposal's current state or from action-row existence.
 */
describe('GovernanceReadService.getTimelock (lifecycle history)', () => {
  function makeTransition(overrides: Record<string, unknown> = {}) {
    return {
      id: `t-${Math.random()}`,
      chainId: 11155420,
      contractAddress: '0x0000000000000000000000000000000000001001',
      proposalId: '1',
      eventName: 'ProposalQueued',
      state: ProposalChainState.QUEUED,
      eta: '1700000000',
      txHash: '0xqueue',
      logIndex: 1,
      blockNumber: '150',
      blockTimestamp: new Date('2026-01-02T00:00:00Z'),
      artifactVersion: 'v1',
      ...overrides,
    } as any;
  }

  function makeProposal(state: ProposalChainState) {
    return {
      id: 'p-1',
      chainId: 11155420,
      proposalId: '1',
      governorAddress: '0x0000000000000000000000000000000000001001',
      proposer: '0x1111111111111111111111111111111111111111',
      proposalHash: '0xdeadbeef',
      description: 'test proposal',
      state,
      eta: '1700000000',
      stateChangedAtBlock: '200',
      stateChangedAt: new Date('2026-01-03T00:00:00Z'),
      artifactVersion: 'v1',
      lastEventTxHash: '0xexec',
      lastEventLogIndex: 2,
    } as any;
  }

  function setup(state: ProposalChainState, rows: any[]) {
    const proposals = {
      findOne: jest.fn(async () => makeProposal(state)),
    };
    const actions = {
      findOne: jest.fn(async () => null),
      find: jest.fn(async () => []),
    };
    const votes = { find: jest.fn(async () => []) };
    const roleChanges = { createQueryBuilder: jest.fn() };
    const transitions = {
      find: jest.fn(async () => [...rows]),
    };
    const service = new GovernanceReadService(
      proposals as any,
      actions as any,
      votes as any,
      roleChanges as any,
      transitions as any,
    );
    return { service, actions, transitions };
  }

  it('queued then executed returns both queuedAtBlock and executedAtBlock', async () => {
    const { service, actions } = setup(ProposalChainState.EXECUTED, [
      makeTransition({
        eventName: 'ProposalQueued',
        state: ProposalChainState.QUEUED,
        txHash: '0xqueue',
        logIndex: 1,
        blockNumber: '150',
      }),
      makeTransition({
        eventName: 'ProposalExecuted',
        state: ProposalChainState.EXECUTED,
        txHash: '0xexec',
        logIndex: 2,
        blockNumber: '200',
        eta: null,
      }),
    ]);

    const result = await service.getTimelock(11155420, '1');

    expect(result.state).toBe(ProposalChainState.EXECUTED);
    expect(result.queuedAtBlock).toBe('150');
    expect(result.executedAtBlock).toBe('200');
    expect(result.cancelledAtBlock).toBeNull();
    expect(result.expiredAtBlock).toBeNull();
    // Queue detection must never consult action rows.
    expect(actions.findOne).not.toHaveBeenCalled();
  });

  it('a queued proposal with no action rows still reports its queued block', async () => {
    const { service } = setup(ProposalChainState.QUEUED, [
      makeTransition({ blockNumber: '150', txHash: '0xqueue' }),
    ]);

    const result = await service.getTimelock(11155420, '1');

    expect(result.queuedAtBlock).toBe('150');
  });

  it('cancelled and expired proposals preserve their preceding queued block', async () => {
    const queued = makeTransition({
      eventName: 'ProposalQueued',
      state: ProposalChainState.QUEUED,
      txHash: '0xqueue',
      logIndex: 1,
      blockNumber: '150',
    });

    const cancelled = setup(ProposalChainState.CANCELLED, [
      queued,
      makeTransition({
        eventName: 'ProposalCanceled',
        state: ProposalChainState.CANCELLED,
        txHash: '0xcancel',
        logIndex: 3,
        blockNumber: '210',
        eta: null,
      }),
    ]);
    const cancelledResult = await cancelled.service.getTimelock(11155420, '1');
    expect(cancelledResult.queuedAtBlock).toBe('150');
    expect(cancelledResult.cancelledAtBlock).toBe('210');
    expect(cancelledResult.executedAtBlock).toBeNull();

    const expired = setup(ProposalChainState.EXPIRED, [
      queued,
      makeTransition({
        eventName: 'ProposalExpired',
        state: ProposalChainState.EXPIRED,
        txHash: '0xexpire',
        logIndex: 4,
        blockNumber: '220',
        eta: null,
      }),
    ]);
    const expiredResult = await expired.service.getTimelock(11155420, '1');
    expect(expiredResult.queuedAtBlock).toBe('150');
    expect(expiredResult.expiredAtBlock).toBe('220');
  });

  it('orders multiple transitions in the same block by logIndex and keeps provenance', async () => {
    const { service } = setup(ProposalChainState.EXECUTED, [
      // Deliberately inserted out of order.
      makeTransition({
        eventName: 'ProposalExecuted',
        state: ProposalChainState.EXECUTED,
        txHash: '0xexec',
        logIndex: 2,
        blockNumber: '200',
        eta: null,
      }),
      makeTransition({
        eventName: 'ProposalQueued',
        state: ProposalChainState.QUEUED,
        txHash: '0xqueue',
        logIndex: 1,
        blockNumber: '200',
      }),
    ]);

    const result = await service.getTimelock(11155420, '1');

    expect(result.transitions.map((t) => [t.eventName, t.logIndex])).toEqual([
      ['ProposalQueued', 1],
      ['ProposalExecuted', 2],
    ]);
    expect(result.transitions[0]).toMatchObject({
      chainId: 11155420,
      contractAddress: '0x0000000000000000000000000000000000001001',
      proposalId: '1',
      txHash: '0xqueue',
      blockNumber: '200',
      artifactVersion: 'v1',
    });
  });

  it('uses canonical event fixtures rather than the current-state shortcut', async () => {
    // Current state says CANCELLED at 210, but the canonical history contains
    // a QUEUED at 150 and an EXECUTED at 200 (e.g. after a partial reorg).
    const { service } = setup(ProposalChainState.CANCELLED, [
      makeTransition({
        eventName: 'ProposalQueued',
        state: ProposalChainState.QUEUED,
        txHash: '0xqueue',
        logIndex: 1,
        blockNumber: '150',
      }),
      makeTransition({
        eventName: 'ProposalExecuted',
        state: ProposalChainState.EXECUTED,
        txHash: '0xexec',
        logIndex: 2,
        blockNumber: '200',
        eta: null,
      }),
    ]);

    const result = await service.getTimelock(11155420, '1');

    expect(result.state).toBe(ProposalChainState.CANCELLED);
    expect((result as any).stateChangedAtBlock).toBeUndefined();
    expect(result.queuedAtBlock).toBe('150');
    expect(result.executedAtBlock).toBe('200');
    expect(result.cancelledAtBlock).toBeNull();
  });

  it('returns null lifecycle fields for a proposal with no lifecycle events', async () => {
    const { service } = setup(ProposalChainState.PENDING, []);

    const result = await service.getTimelock(11155420, '1');

    expect(result.queuedAtBlock).toBeNull();
    expect(result.executedAtBlock).toBeNull();
    expect(result.cancelledAtBlock).toBeNull();
    expect(result.expiredAtBlock).toBeNull();
    expect(result.transitions).toEqual([]);
  });
});

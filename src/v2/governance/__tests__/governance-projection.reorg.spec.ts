import { GovernanceProjectionService } from '../governance-projection.service';
import {
  GovernanceProposal,
  ProposalChainState,
} from '../entities/governance-proposal.entity';
import { GovernanceAction } from '../entities/governance-action.entity';
import { ProposalVote } from '../entities/proposal-vote.entity';
import { RoleChange } from '../entities/role-change.entity';
import { CanonicalEvent } from '../../events/entities/canonical-event.entity';

const CHAIN_ID = 11155420;
const GOVERNOR = '0x0000000000000000000000000000000000001001';
const CHECKPOINT = 250n;

type Row = { id?: string; [key: string]: any };

function makeRepo<T extends Row>(name: string) {
  const store: T[] = [];
  const queries: Array<{ sql: string; params: any }> = [];
  const repo: any = {
    _store: store,
    _queries: queries,
    metadata: { connection: { options: { type: 'better-sqlite3' } } },
    manager: null,
    findOne: jest.fn(
      async ({ where }: any) =>
        store.find((row) =>
          Object.entries(where).every(([k, v]) => (row as any)[k] === v),
        ) ?? null,
    ),
    create: jest.fn((row: Partial<T>) => row as T),
    save: jest.fn(async (row: T) => {
      if (!row.id) row.id = `${name}-${store.length + 1}`;
      const idx = store.findIndex((r) => r.id === row.id);
      if (idx >= 0) store[idx] = row;
      else store.push(row);
      return row;
    }),
    delete: jest.fn(async (criteria: any) => {
      const matching = store.filter((r) =>
        Object.entries(criteria).every(([k, v]) => (r as any)[k] === v),
      );
      for (const row of matching) {
        const idx = store.indexOf(row);
        if (idx >= 0) store.splice(idx, 1);
      }
      return { affected: matching.length };
    }),
    createQueryBuilder: jest.fn(() => {
      const state: { sql: string[]; params: any } = { sql: [], params: {} };
      const qb: any = {
        where: jest.fn((sql: string, params?: any) => {
          state.sql.push(sql);
          Object.assign(state.params, params ?? {});
          queries.push({ sql, params: { ...(params ?? {}) } });
          return qb;
        }),
        andWhere: jest.fn((sql: string, params?: any) => {
          state.sql.push(sql);
          Object.assign(state.params, params ?? {});
          queries.push({ sql, params: { ...(params ?? {}) } });
          return qb;
        }),
        orderBy: jest.fn(() => qb),
        addOrderBy: jest.fn(() => qb),
        getMany: jest.fn(async () => {
          if (name !== 'events') {
            if (name === 'proposals') {
              return store.filter(
                (r: any) =>
                  r.chainId === state.params.chainId &&
                  BigInt(r.stateChangedAtBlock) >
                    BigInt(state.params.rollbackToBlock),
              );
            }
            return [...store];
          }
          return store
            .filter((e: any) => e.chainId === state.params.chainId)
            .filter(
              (e: any) =>
                !state.params.eventNames ||
                state.params.eventNames.includes(e.eventName),
            )
            .filter(
              (e: any) =>
                BigInt(e.blockNumber) <= BigInt(state.params.rollbackToBlock),
            )
            .filter(
              (e: any) =>
                !state.params.governorAddress ||
                e.contractAddress === state.params.governorAddress,
            )
            .filter(
              (e: any) =>
                state.params.proposalId === undefined ||
                String(e.payload?.proposalId) === state.params.proposalId,
            );
        }),
        getOne: jest.fn(async () => (await qb.getMany())[0] ?? null),
        delete: jest.fn(() => {
          const deleteState: { params: any } = { params: {} };
          const builder: any = {
            where: jest.fn((_sql: string, params?: any) => {
              Object.assign(deleteState.params, params ?? {});
              return builder;
            }),
            andWhere: jest.fn((_sql: string, params?: any) => {
              Object.assign(deleteState.params, params ?? {});
              return builder;
            }),
            execute: jest.fn(async () => {
              const matching = store.filter(
                (r: any) =>
                  r.chainId === deleteState.params.chainId &&
                  BigInt(r.blockNumber) >
                    BigInt(deleteState.params.rollbackToBlock),
              );
              for (const row of matching) {
                const idx = store.indexOf(row);
                if (idx >= 0) store.splice(idx, 1);
              }
              return { affected: matching.length };
            }),
          };
          return builder;
        }),
      };
      return qb;
    }),
  };
  return repo;
}

function makeEvent(overrides: Partial<CanonicalEvent>): CanonicalEvent {
  return {
    id: `e-${Math.random()}`,
    chainId: CHAIN_ID,
    contractAddress: GOVERNOR,
    artifactVersion: 'v1',
    eventName: 'ProposalCreated',
    txHash: '0xcreate',
    logIndex: 0,
    blockNumber: '100',
    blockTimestamp: new Date('2026-01-01T00:00:00Z'),
    actor: null,
    claimId: null,
    roundId: null,
    asset: null,
    amount: null,
    payload: { proposalId: '1' } as any,
    rawArgs: {} as any,
    ...overrides,
  } as unknown as CanonicalEvent;
}

function makeProposal(overrides: Partial<GovernanceProposal> = {}): any {
  return {
    id: 'p-1',
    chainId: CHAIN_ID,
    proposalId: '1',
    governorAddress: GOVERNOR,
    proposer: '0x1111111111111111111111111111111111111111',
    proposalHash: '0xdeadbeef',
    description: 'reorg regression proposal',
    state: ProposalChainState.EXECUTED,
    eta: null,
    stateChangedAtBlock: '300',
    stateChangedAt: new Date('2026-01-01T00:00:00Z'),
    artifactVersion: 'v1',
    lastEventTxHash: '0xexecute',
    lastEventLogIndex: 0,
    ...overrides,
  };
}

describe('GovernanceProjectionService — reorg rollback lifecycle restoration', () => {
  let proposals: ReturnType<typeof makeRepo>;
  let actions: ReturnType<typeof makeRepo>;
  let votes: ReturnType<typeof makeRepo>;
  let roleChanges: ReturnType<typeof makeRepo>;
  let events: ReturnType<typeof makeRepo>;
  let transaction: jest.Mock;
  let service: GovernanceProjectionService;

  beforeEach(() => {
    proposals = makeRepo('proposals');
    actions = makeRepo('actions');
    votes = makeRepo('votes');
    roleChanges = makeRepo('roleChanges');
    events = makeRepo('events');

    const repos: Record<string, any> = {
      [GovernanceProposal.name]: proposals,
      [GovernanceAction.name]: actions,
      [ProposalVote.name]: votes,
      [RoleChange.name]: roleChanges,
      [CanonicalEvent.name]: events,
    };

    transaction = jest.fn(async (work: (tx: any) => Promise<any>) => {
      const snapshot: Record<string, any[]> = {};
      for (const [key, repo] of Object.entries(repos)) {
        snapshot[key] = JSON.parse(JSON.stringify(repo._store));
      }
      const tx = {
        getRepository: jest.fn((entity: any) => repos[entity.name]),
      };
      try {
        return await work(tx);
      } catch (error) {
        // Emulate a database transaction rollback.
        for (const [key, repo] of Object.entries(repos)) {
          repo._store.splice(
            0,
            repo._store.length,
            ...snapshot[key].map((row) => ({ ...row })),
          );
        }
        throw error;
      }
    });
    proposals.manager = { transaction };

    service = new GovernanceProjectionService(
      proposals as any,
      actions as any,
      votes as any,
      roleChanges as any,
      events as any,
      { resolve: jest.fn(async () => null) } as any,
      { decodeCall: jest.fn(() => ({ target: '0x0' })) } as any,
    );
  });

  it('keeps a queued proposal QUEUED when a VoteCast is its last event', async () => {
    proposals._store.push(makeProposal({ state: ProposalChainState.QUEUED }));
    events._store.push(
      makeEvent({
        eventName: 'ProposalCreated',
        txHash: '0xcreate',
        logIndex: 0,
      }),
      makeEvent({
        eventName: 'ProposalQueued',
        txHash: '0xqueue',
        logIndex: 1,
        blockNumber: '150',
        payload: { proposalId: '1', eta: '1700000000' } as any,
      }),
      makeEvent({
        eventName: 'VoteCast',
        txHash: '0xvote',
        logIndex: 2,
        blockNumber: '200',
        payload: { proposalId: '1', support: '1', voter: '0xaa' } as any,
      }),
      makeEvent({
        eventName: 'ProposalExecuted',
        txHash: '0xexecute',
        logIndex: 0,
        blockNumber: '300',
      }),
    );

    await service.rollbackAboveBlock(CHAIN_ID, CHECKPOINT);

    const proposal = proposals._store[0] as any;
    expect(proposal.state).toBe(ProposalChainState.QUEUED);
    expect(proposal.stateChangedAtBlock).toBe('150');
    expect(proposal.lastEventTxHash).toBe('0xqueue');

    const typedPredicate = events._queries.find((q) =>
      q.sql.includes("json_extract(e.payload, '$.proposalId')"),
    );
    expect(typedPredicate?.params.proposalId).toBe('1');
    expect(events._queries.some((q) => q.sql.includes('payload LIKE'))).toBe(
      false,
    );
  });

  it('keeps an executed proposal EXECUTED across a later vote', async () => {
    proposals._store.push(makeProposal());
    events._store.push(
      makeEvent({ eventName: 'ProposalCreated' }),
      makeEvent({
        eventName: 'ProposalQueued',
        txHash: '0xqueue',
        logIndex: 1,
        blockNumber: '150',
      }),
      makeEvent({
        eventName: 'ProposalExecuted',
        txHash: '0xexecuted-before-checkpoint',
        logIndex: 0,
        blockNumber: '200',
      }),
      makeEvent({
        eventName: 'VoteCast',
        txHash: '0xvote',
        logIndex: 4,
        blockNumber: '220',
      }),
      makeEvent({
        eventName: 'ProposalCanceled',
        txHash: '0xcancel',
        logIndex: 0,
        blockNumber: '300',
      }),
    );

    await service.rollbackAboveBlock(CHAIN_ID, CHECKPOINT);

    expect((proposals._store[0] as any).state).toBe(
      ProposalChainState.EXECUTED,
    );
    expect((proposals._store[0] as any).lastEventTxHash).toBe(
      '0xexecuted-before-checkpoint',
    );
  });

  it('restores the preceding lifecycle state when the latest transition is rolled back', async () => {
    proposals._store.push(makeProposal());
    events._store.push(
      makeEvent({ eventName: 'ProposalCreated' }),
      makeEvent({
        eventName: 'ProposalQueued',
        txHash: '0xqueue',
        logIndex: 0,
        blockNumber: '300',
      }),
    );

    await service.rollbackAboveBlock(CHAIN_ID, CHECKPOINT);

    expect((proposals._store[0] as any).state).toBe(ProposalChainState.PENDING);
    expect((proposals._store[0] as any).lastEventTxHash).toBe('0xcreate');
  });

  it('restores an earlier QUEUED state when a later execution is removed', async () => {
    proposals._store.push(makeProposal());
    events._store.push(
      makeEvent({ eventName: 'ProposalCreated' }),
      makeEvent({
        eventName: 'ProposalQueued',
        txHash: '0xqueue',
        logIndex: 1,
        blockNumber: '150',
      }),
      makeEvent({
        eventName: 'ProposalExecuted',
        txHash: '0xexecute',
        logIndex: 0,
        blockNumber: '300',
      }),
    );

    await service.rollbackAboveBlock(CHAIN_ID, CHECKPOINT);

    expect((proposals._store[0] as any).state).toBe(ProposalChainState.QUEUED);
  });

  it('never derives state from VoteCast or role-change events', async () => {
    proposals._store.push(makeProposal());
    events._store.push(
      makeEvent({ eventName: 'ProposalCreated' }),
      makeEvent({
        eventName: 'ProposalQueued',
        txHash: '0xqueue',
        logIndex: 1,
        blockNumber: '150',
      }),
      makeEvent({
        eventName: 'VoteCast',
        txHash: '0xvote',
        logIndex: 0,
        blockNumber: '210',
      }),
      makeEvent({
        eventName: 'RoleGranted',
        txHash: '0xgrant',
        logIndex: 0,
        blockNumber: '220',
      }),
      makeEvent({
        eventName: 'RoleRevoked',
        txHash: '0xrevoke',
        logIndex: 0,
        blockNumber: '230',
      }),
      makeEvent({
        eventName: 'ProposalExecuted',
        txHash: '0xexecute',
        logIndex: 0,
        blockNumber: '300',
      }),
    );

    await service.rollbackAboveBlock(CHAIN_ID, CHECKPOINT);

    expect((proposals._store[0] as any).state).toBe(ProposalChainState.QUEUED);
    expect((service as any).mapEventToState('VoteCast')).toBeNull();
    expect((service as any).mapEventToState('RoleGranted')).toBeNull();
  });

  it('deletes the proposal and its actions when no ProposalCreated survives', async () => {
    proposals._store.push(makeProposal());
    actions._store.push(
      { id: 'a-1', chainId: CHAIN_ID, proposalId: '1', actionIndex: 0 },
      { id: 'a-2', chainId: CHAIN_ID, proposalId: '1', actionIndex: 1 },
    );
    events._store.push(
      makeEvent({
        eventName: 'ProposalQueued',
        txHash: '0xqueue',
        logIndex: 0,
        blockNumber: '150',
      }),
      makeEvent({
        eventName: 'VoteCast',
        txHash: '0xvote',
        logIndex: 2,
        blockNumber: '200',
      }),
      makeEvent({
        eventName: 'ProposalExecuted',
        txHash: '0xexecute',
        logIndex: 0,
        blockNumber: '300',
      }),
    );

    await service.rollbackAboveBlock(CHAIN_ID, CHECKPOINT);

    expect(proposals._store).toHaveLength(0);
    expect(actions._store).toHaveLength(0);
  });

  it('orders same-block events by logIndex deterministically', async () => {
    proposals._store.push(makeProposal());
    events._store.push(
      makeEvent({ eventName: 'ProposalCreated' }),
      makeEvent({
        eventName: 'ProposalExecuted',
        txHash: '0xlower-log',
        logIndex: 1,
        blockNumber: '200',
      }),
      makeEvent({
        eventName: 'ProposalQueued',
        txHash: '0xhigher-log',
        logIndex: 3,
        blockNumber: '200',
      }),
      makeEvent({
        eventName: 'VoteCast',
        txHash: '0xvote',
        logIndex: 9,
        blockNumber: '200',
      }),
      makeEvent({
        eventName: 'ProposalCanceled',
        txHash: '0xcancel',
        logIndex: 0,
        blockNumber: '300',
      }),
    );

    await service.rollbackAboveBlock(CHAIN_ID, CHECKPOINT);

    expect((proposals._store[0] as any).state).toBe(ProposalChainState.QUEUED);
    expect((proposals._store[0] as any).lastEventTxHash).toBe('0xhigher-log');
    expect((proposals._store[0] as any).lastEventLogIndex).toBe(3);
  });

  it('keeps state and actions consistent when the transaction fails', async () => {
    proposals._store.push(makeProposal());
    actions._store.push({
      id: 'a-1',
      chainId: CHAIN_ID,
      proposalId: '1',
      actionIndex: 0,
    });
    events._store.push(
      makeEvent({ eventName: 'ProposalCreated' }),
      makeEvent({
        eventName: 'ProposalQueued',
        txHash: '0xqueue',
        logIndex: 1,
        blockNumber: '150',
      }),
      makeEvent({
        eventName: 'ProposalExecuted',
        txHash: '0xexecute',
        logIndex: 0,
        blockNumber: '300',
      }),
    );
    actions.delete.mockImplementationOnce(async () => {
      throw new Error('disk write failed');
    });

    await expect(
      service.rollbackAboveBlock(CHAIN_ID, CHECKPOINT),
    ).rejects.toThrow('disk write failed');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect((proposals._store[0] as any).state).toBe(
      ProposalChainState.EXECUTED,
    );
    expect((proposals._store[0] as any).stateChangedAtBlock).toBe('300');
    expect(actions._store).toHaveLength(1);
  });

  it('uses a typed Postgres JSON predicate and chain/governor scoping', async () => {
    events.metadata.connection.options.type = 'postgres';
    proposals._store.push(makeProposal());
    events._store.push(makeEvent({ eventName: 'ProposalCreated' }));

    await service.rollbackAboveBlock(CHAIN_ID, CHECKPOINT);

    const allSql = events._queries.map((q) => q.sql).join(' | ');
    expect(allSql).toContain("e.payload->>'proposalId'");
    expect(allSql).toContain('e.eventName IN (:...eventNames)');
    expect(allSql).toContain('e.chainId = :chainId');
    expect(allSql).toContain('e.contractAddress = :governorAddress');
    expect(allSql).not.toContain('payload LIKE');

    const lifecycleQuery = events._queries.find((q) =>
      q.sql.includes('e.eventName IN (:...eventNames)'),
    );
    expect(lifecycleQuery?.params.eventNames).toEqual([
      'ProposalCreated',
      'ProposalQueued',
      'ProposalExecuted',
      'ProposalCanceled',
      'ProposalExpired',
    ]);
  });
});

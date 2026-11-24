import { GovernanceProjectionService } from '../governance-projection.service';
import { ProposalChainState } from '../entities/governance-proposal.entity';
import { RoleChangeKind } from '../entities/role-change.entity';
import { CanonicalEvent } from '../../events/entities/canonical-event.entity';

/**
 * Unit coverage for GovernanceProjectionService — V2-BE-067.
 *
 * Required test categories from the issue:
 *   - queued / executed / cancelled / expired state transitions
 *   - reorg reconciliation
 *   - ABI change (artifact drift detection)
 */
describe('GovernanceProjectionService', () => {
  // ─── In-memory stores to stand in for TypeORM repositories ──────────────

  function makeRepo<T extends { id?: string }>() {
    const store: T[] = [];
    return {
      _store: store,
      findOne: jest.fn(async ({ where }: any) => {
        return (
          store.find((row) =>
            Object.entries(where).every(
              ([k, v]) => (row as any)[k] === v,
            ),
          ) ?? null
        );
      }),
      save: jest.fn(async (row: T) => {
        if (!(row as any).id) {
          (row as any).id = `id-${store.length + 1}`;
        }
        const idx = store.findIndex((r) => (r as any).id === (row as any).id);
        if (idx >= 0) store[idx] = row;
        else store.push(row);
        return row;
      }),
      create: jest.fn((row: Partial<T>) => row as T),
      delete: jest.fn(async (criteria: any) => {
        const matching = store.filter((r) =>
          Object.entries(criteria).every(
            ([k, v]) => (r as any)[k] === v,
          ),
        );
        for (const m of matching) {
          const idx = store.indexOf(m);
          if (idx >= 0) store.splice(idx, 1);
        }
        return { affected: matching.length };
      }),
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          _filters: {},
          where: jest.fn(function (this: any, sql, params) {
            Object.assign(this._filters, params ?? {});
            return this;
          }),
          andWhere: jest.fn(function (this: any) {
            return this;
          }),
          orderBy: jest.fn(function (this: any) {
            return this;
          }),
          addOrderBy: jest.fn(function (this: any) {
            return this;
          }),
          limit: jest.fn(function (this: any) {
            return this;
          }),
          take: jest.fn(function (this: any) {
            return this;
          }),
          getMany: jest.fn(async () => store),
          getOne: jest.fn(async () => store[0] ?? null),
          delete: jest.fn(function (this: any) {
            return {
              where: jest.fn(function (this: any) {
                return this;
              }),
              andWhere: jest.fn(function (this: any) {
                return this;
              }),
              execute: jest.fn(async () => ({ affected: 0 })),
            };
          }),
        };
        return qb;
      }),
    };
  }

  function makeEvent(overrides: Partial<CanonicalEvent>): CanonicalEvent {
    return {
      id: 'e-1',
      chainId: 11155420,
      contractAddress: '0x0000000000000000000000000000000000001001',
      artifactVersion: 'v1',
      eventName: 'ProposalCreated',
      txHash: '0xabc',
      logIndex: 0,
      blockNumber: '100',
      blockTimestamp: new Date('2026-01-01T00:00:00Z'),
      actor: null,
      claimId: null,
      roundId: null,
      asset: null,
      amount: null,
      payload: {},
      rawArgs: {},
      ...overrides,
    } as unknown as CanonicalEvent;
  }

  let proposals: ReturnType<typeof makeRepo>;
  let actions: ReturnType<typeof makeRepo>;
  let votes: ReturnType<typeof makeRepo>;
  let roleChanges: ReturnType<typeof makeRepo>;
  let events: ReturnType<typeof makeRepo>;
  let artifactRegistry: any;
  let decoder: any;
  let service: GovernanceProjectionService;

  beforeEach(() => {
    proposals = makeRepo();
    actions = makeRepo();
    votes = makeRepo();
    roleChanges = makeRepo();
    events = makeRepo();
    artifactRegistry = { resolve: jest.fn(async () => null) };
    decoder = {
      decodeCall: jest.fn((target, value, calldata) => ({
        target,
        valueWei: value,
        calldata,
        selector: '0x12345678',
        functionSignature: 'transfer(address,uint256)',
        selectorUnknown: false,
        decodedArgs: { to: '0x0', amount: '1' },
        calldataChecksum: 'a'.repeat(64),
      })),
    };

    service = new GovernanceProjectionService(
      proposals as any,
      actions as any,
      votes as any,
      roleChanges as any,
      events as any,
      artifactRegistry as any,
      decoder as any,
    );
  });

  // ─── State transitions ──────────────────────────────────────────────────

  async function seedProposal(state = ProposalChainState.PENDING) {
    proposals._store.push({
      id: 'p-1',
      chainId: 11155420,
      proposalId: '1',
      governorAddress: '0x0000000000000000000000000000000000001001',
      proposer: '0x1111111111111111111111111111111111111111',
      proposalHash: '0xdeadbeef',
      description: 'test proposal',
      state,
      eta: null,
      stateChangedAtBlock: '100',
      stateChangedAt: new Date('2026-01-01T00:00:00Z'),
      artifactVersion: 'v1',
      lastEventTxHash: '0xabc',
      lastEventLogIndex: 0,
    } as any);
  }

  it('projectStateTransition → QUEUED sets state + eta from event payload', async () => {
    await seedProposal(ProposalChainState.PENDING);

    const event = makeEvent({
      eventName: 'ProposalQueued',
      txHash: '0xqueue',
      logIndex: 1,
      blockNumber: '150',
      payload: { proposalId: '1', eta: '1700000000' } as any,
    });

    await (service as any).projectEvent(event);

    const updated = proposals._store[0] as any;
    expect(updated.state).toBe(ProposalChainState.QUEUED);
    expect(updated.eta).toBe('1700000000');
    expect(updated.stateChangedAtBlock).toBe('150');
    expect(updated.lastEventTxHash).toBe('0xqueue');
  });

  it('projectStateTransition → EXECUTED sets state', async () => {
    await seedProposal(ProposalChainState.QUEUED);

    const event = makeEvent({
      eventName: 'ProposalExecuted',
      txHash: '0xexec',
      logIndex: 2,
      blockNumber: '200',
      payload: { proposalId: '1' } as any,
    });

    await (service as any).projectEvent(event);
    expect((proposals._store[0] as any).state).toBe(
      ProposalChainState.EXECUTED,
    );
  });

  it('projectStateTransition → CANCELLED sets state', async () => {
    await seedProposal();
    const event = makeEvent({
      eventName: 'ProposalCanceled',
      txHash: '0xcancel',
      logIndex: 3,
      blockNumber: '210',
      payload: { proposalId: '1' } as any,
    });
    await (service as any).projectEvent(event);
    expect((proposals._store[0] as any).state).toBe(
      ProposalChainState.CANCELLED,
    );
  });

  it('projectStateTransition → EXPIRED sets state', async () => {
    await seedProposal();
    const event = makeEvent({
      eventName: 'ProposalExpired',
      txHash: '0xexpire',
      logIndex: 4,
      blockNumber: '220',
      payload: { proposalId: '1' } as any,
    });
    await (service as any).projectEvent(event);
    expect((proposals._store[0] as any).state).toBe(
      ProposalChainState.EXPIRED,
    );
  });

  it('detects artifact drift (ABI change) and refuses to silently reinterpret', async () => {
    await seedProposal(ProposalChainState.PENDING); // created under v1

    const event = makeEvent({
      eventName: 'ProposalQueued',
      artifactVersion: 'v2', // ABI changed between creation and queue
      txHash: '0xdrift',
      logIndex: 5,
      blockNumber: '250',
      payload: { proposalId: '1', eta: '1700000000' } as any,
    });

    const outcome = await (service as any).projectEvent(event);

    expect(outcome).toBe('stale_artifact');
    // State must NOT be mutated by a stale-artifact event.
    expect((proposals._store[0] as any).state).toBe(
      ProposalChainState.PENDING,
    );
  });

  it('is idempotent: replaying the same (txHash, logIndex) is a no-op', async () => {
    await seedProposal(ProposalChainState.PENDING);

    const event = makeEvent({
      eventName: 'ProposalQueued',
      txHash: '0xqueue',
      logIndex: 1,
      blockNumber: '150',
      payload: { proposalId: '1', eta: '1700000000' } as any,
    });

    const first = await (service as any).projectEvent(event);
    const second = await (service as any).projectEvent(event);

    expect(first).toBe('applied');
    expect(second).toBe('duplicate');
  });

  // ─── Reorg ──────────────────────────────────────────────────────────────

  it('rollbackAboveBlock resets a stale proposal to the last canonical event', async () => {
    await seedProposal(ProposalChainState.QUEUED);
    (proposals._store[0] as any).stateChangedAtBlock = '300';
    (proposals._store[0] as any).lastEventTxHash = '0xqueue';
    (proposals._store[0] as any).lastEventLogIndex = 1;

    // Simulate the last canonical event for this proposal being ProposalCreated
    // at block 100 (which is <= rollbackToBlock of 250).
    const lastValid = makeEvent({
      eventName: 'ProposalCreated',
      txHash: '0xabc',
      logIndex: 0,
      blockNumber: '100',
      payload: { proposalId: '1', descriptionHash: '0xdeadbeef' } as any,
    });
    events._store.push(lastValid);

    // Provide a getOne that returns the last valid event.
    events.createQueryBuilder = jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => lastValid),
      getMany: jest.fn(async () => [lastValid]),
      delete: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn(async () => ({ affected: 0 })),
      })),
    }));

    await service.rollbackAboveBlock(11155420, 250n);

    // Proposal must be reverted to whatever the last canonical event says.
    const p = proposals._store[0] as any;
    expect(p.state).toBe(ProposalChainState.PENDING);
    expect(p.lastEventTxHash).toBe('0xabc');
    expect(p.lastEventLogIndex).toBe(0);
  });

  it('rollbackAboveBlock deletes proposals with no canonical backing event', async () => {
    await seedProposal(ProposalChainState.QUEUED);
    (proposals._store[0] as any).stateChangedAtBlock = '400';

    // No canonical event remains.
    events.createQueryBuilder = jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => null),
      getMany: jest.fn(async () => []),
      delete: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn(async () => ({ affected: 0 })),
      })),
    }));

    await service.rollbackAboveBlock(11155420, 250n);

    expect(proposals._store.length).toBe(0);
  });

  // ─── Role changes ───────────────────────────────────────────────────────

  it('projects RoleGranted into the audit trail', async () => {
    const event = makeEvent({
      eventName: 'RoleGranted',
      txHash: '0xgrant',
      logIndex: 10,
      blockNumber: '500',
      payload: {
        role: '0x' + '1'.repeat(64),
        account: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sender: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      } as any,
    });

    await (service as any).projectEvent(event);

    expect(roleChanges._store.length).toBe(1);
    const row = roleChanges._store[0] as any;
    expect(row.kind).toBe(RoleChangeKind.GRANTED);
    expect(row.account).toBe(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(row.sender).toBe(
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
  });

  it('is idempotent for RoleGranted — duplicate txHash+logIndex is skipped', async () => {
    const event = makeEvent({
      eventName: 'RoleGranted',
      txHash: '0xgrant',
      logIndex: 10,
      blockNumber: '500',
      payload: {
        role: '0x' + '1'.repeat(64),
        account: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sender: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      } as any,
    });

    await (service as any).projectEvent(event);
    await (service as any).projectEvent(event);

    expect(roleChanges._store.length).toBe(1);
  });
});

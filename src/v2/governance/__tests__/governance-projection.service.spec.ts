import { GovernanceProjectionService } from '../governance-projection.service';
import { ProposalChainState } from '../entities/governance-proposal.entity';
import { RoleChangeKind } from '../entities/role-change.entity';
import { CanonicalEvent } from '../../events/entities/canonical-event.entity';

/**
 * Unit coverage for GovernanceProjectionService — V2-BE-067 / PREWAVE-BE-192.
 *
 * The in-memory repositories and transaction runner reproduce the persistence
 * contract: writes made inside `TransactionRunner.run()` are rolled back as a
 * unit on failure, and two runs can never interleave.
 */
describe('GovernanceProjectionService', () => {
  const TARGET_A = '0x1111111111111111111111111111111111111111';
  const TARGET_B = '0x2222222222222222222222222222222222222222';

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
      find: jest.fn(async ({ where }: any) =>
        store.filter((row) =>
          Object.entries(where ?? {}).every(
            ([k, v]) => (row as any)[k] === v,
          ),
        ),
      ),
      save: jest.fn(async (input: T | T[]) => {
        const rows = Array.isArray(input) ? input : [input];
        const saved: T[] = [];
        for (const row of rows) {
          if (!(row as any).id) {
            (row as any).id = `id-${store.length + 1}-${saved.length}`;
          }
          const idx = store.findIndex((r) => (r as any).id === (row as any).id);
          if (idx >= 0) store[idx] = row;
          else store.push(row);
          saved.push(row);
        }
        return Array.isArray(input) ? saved : saved[0];
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
          setLock: jest.fn(function (this: any) {
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
          getOne: jest.fn(async () => {
            return (
              store.find((row) =>
                Object.entries(qb._filters).every(
                  ([k, v]) => (row as any)[k] === v,
                ),
              ) ?? null
            );
          }),
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

  type Repos = {
    proposals: ReturnType<typeof makeRepo>;
    actions: ReturnType<typeof makeRepo>;
    votes: ReturnType<typeof makeRepo>;
    roleChanges: ReturnType<typeof makeRepo>;
    events: ReturnType<typeof makeRepo>;
  };

  function makeTransactionRunner(repos: Repos) {
    const isolationLevels: any[] = [];
    let tail: Promise<unknown> = Promise.resolve();
    let active = 0;
    let maxActive = 0;

    const run = jest.fn(async (callback: (manager: any) => Promise<any>, options?: any) => {
      const attempt = tail.then(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        isolationLevels.push(options?.isolationLevel);
        const snapshots = new Map<string, any[]>();
        for (const [key, repo] of Object.entries(repos)) {
          snapshots.set(key, (repo as any)._store.map((row: any) => ({ ...row })));
        }
        try {
          const manager = {
            getRepository: (entity: any) => {
              switch (entity?.name) {
                case 'GovernanceProposal':
                  return repos.proposals;
                case 'GovernanceAction':
                  return repos.actions;
                case 'ProposalVote':
                  return repos.votes;
                case 'RoleChange':
                  return repos.roleChanges;
                case 'CanonicalEvent':
                  return repos.events;
                default:
                  throw new Error(`Unexpected repository: ${entity?.name}`);
              }
            },
          };
          return await callback(manager);
        } catch (error) {
          for (const [key, snapshot] of snapshots) {
            const store = (repos as any)[key]._store;
            store.splice(0, store.length, ...snapshot);
          }
          throw error;
        } finally {
          active--;
        }
      });
      tail = attempt.catch(() => undefined);
      return attempt;
    });

    return {
      run,
      isolationLevels,
      maxActive: () => maxActive,
    } as any;
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

  function makeCreatedEvent(
    overrides: Partial<CanonicalEvent> = {},
  ): CanonicalEvent {
    return makeEvent({
      eventName: 'ProposalCreated',
      txHash: '0xcreate',
      logIndex: 0,
      blockNumber: '100',
      payload: {
        proposalId: '1',
        targets: [TARGET_A, TARGET_B],
        values: ['0', '1'],
        calldatas: ['0x12345678', '0xabcdef01'],
        descriptionHash: '0xdeadbeef',
        description: 'test proposal',
        proposer: '0x3333333333333333333333333333333333333333',
      } as any,
      ...overrides,
    });
  }

  let proposals: ReturnType<typeof makeRepo>;
  let actions: ReturnType<typeof makeRepo>;
  let votes: ReturnType<typeof makeRepo>;
  let roleChanges: ReturnType<typeof makeRepo>;
  let events: ReturnType<typeof makeRepo>;
  let txRunner: ReturnType<typeof makeTransactionRunner>;
  let artifactRegistry: any;
  let decoder: any;
  let service: GovernanceProjectionService;

  beforeEach(() => {
    proposals = makeRepo();
    actions = makeRepo();
    votes = makeRepo();
    roleChanges = makeRepo();
    events = makeRepo();
    txRunner = makeTransactionRunner({
      proposals,
      actions,
      votes,
      roleChanges,
      events,
    });
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
      txRunner as any,
    );
  });

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
      createdEventTxHash: null,
      createdEventLogIndex: null,
      actionCount: 0,
    } as any);
  }

  function seedActions(checksum = 'b'.repeat(64)) {
    actions._store.push({
      id: 'a-old-1',
      chainId: 11155420,
      proposalId: '1',
      actionIndex: 0,
      target: TARGET_A,
      valueWei: '0',
      calldata: '0xold',
      selector: '0xold',
      functionSignature: null,
      selectorUnknown: true,
      decodedArgs: null,
      calldataChecksum: checksum,
      artifactVersion: 'v1',
    } as any);
  }

  // ─── State transitions ──────────────────────────────────────────────────

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

  // ─── ProposalCreated atomicity ─────────────────────────────────────────

  it('a decoding failure leaves the prior proposal/action projection unchanged', async () => {
    await seedProposal();
    seedActions();
    decoder.decodeCall.mockImplementationOnce(() => {
      throw new Error('decode boom');
    });

    await expect(
      (service as any).projectEvent(
        makeCreatedEvent({ txHash: '0xnew', blockNumber: '150' }),
      ),
    ).rejects.toThrow('decode boom');

    expect(proposals._store.length).toBe(1);
    expect((proposals._store[0] as any).lastEventTxHash).toBe('0xabc');
    expect((proposals._store[0] as any).createdEventTxHash).toBeNull();
    expect(actions._store).toHaveLength(1);
    expect((actions._store[0] as any).calldata).toBe('0xold');
    expect(txRunner.run).not.toHaveBeenCalled();
  });

  it('a save failure rolls back the proposal update and all action changes', async () => {
    await seedProposal();
    seedActions();
    actions.save.mockImplementationOnce(async () => {
      throw new Error('save boom');
    });

    await expect(
      (service as any).projectEvent(
        makeCreatedEvent({ txHash: '0xnew', blockNumber: '150' }),
      ),
    ).rejects.toThrow('save boom');

    expect((proposals._store[0] as any).lastEventTxHash).toBe('0xabc');
    expect((proposals._store[0] as any).createdEventTxHash).toBeNull();
    expect(actions._store).toHaveLength(1);
    expect((actions._store[0] as any).calldata).toBe('0xold');
  });

  it('a successful projection replaces the full action set in one transaction', async () => {
    seedActions();

    const outcome = await (service as any).projectEvent(makeCreatedEvent());
    expect(outcome).toBe('applied');
    expect(txRunner.run).toHaveBeenCalledTimes(1);

    expect(actions._store).toHaveLength(2);
    expect(actions._store.map((a: any) => a.actionIndex)).toEqual([0, 1]);
    expect(actions._store.map((a: any) => a.target)).toEqual([
      TARGET_A,
      TARGET_B,
    ]);
    expect((proposals._store[0] as any).createdEventTxHash).toBe('0xcreate');
    expect((proposals._store[0] as any).createdEventLogIndex).toBe(0);
    expect((proposals._store[0] as any).actionCount).toBe(2);
    // The replacement is one bulk write inside the transaction, not one
    // independent save per action.
    expect(actions.save).toHaveBeenCalledTimes(1);
    expect(actions.delete).toHaveBeenCalledTimes(1);
  });

  it('replaying the same canonical event produces no duplicate or partial rows', async () => {
    const event = makeCreatedEvent();
    expect(await (service as any).projectEvent(event)).toBe('applied');
    expect(await (service as any).projectEvent(event)).toBe('duplicate');
    expect(actions._store).toHaveLength(2);
    expect(txRunner.run).toHaveBeenCalledTimes(1);
  });

  it('a later state transition does not invalidate ProposalCreated idempotency', async () => {
    const created = makeCreatedEvent();
    await (service as any).projectEvent(created);

    await (service as any).projectEvent(
      makeEvent({
        eventName: 'ProposalQueued',
        txHash: '0xqueue',
        logIndex: 1,
        blockNumber: '150',
        payload: { proposalId: '1', eta: '1700000000' } as any,
      }),
    );

    expect(await (service as any).projectEvent(created)).toBe('duplicate');
    expect((proposals._store[0] as any).state).toBe(ProposalChainState.QUEUED);
    expect(actions._store).toHaveLength(2);
  });

  it('replays a partially applied legacy projection by replacing it atomically', async () => {
    // Legacy mixed state written by the old non-atomic projector: the
    // proposal's lastEvent marker matches, but no committed action-set
    // identity exists and only one action row survived. The missing marker
    // must force a full atomic repair.
    await seedProposal();
    (proposals._store[0] as any).lastEventTxHash = '0xcreate';
    (proposals._store[0] as any).createdEventTxHash = null;
    (proposals._store[0] as any).createdEventLogIndex = null;
    (proposals._store[0] as any).actionCount = 0;
    seedActions();

    const outcome = await (service as any).projectEvent(makeCreatedEvent());
    expect(outcome).toBe('applied');
    expect(actions._store).toHaveLength(2);
    expect(actions._store.map((a: any) => a.calldata)).toEqual([
      '0x12345678',
      '0xabcdef01',
    ]);
  });

  it('concurrent projection attempts cannot interleave action replacement', async () => {
    const event = makeCreatedEvent();
    const outcomes = await Promise.all([
      (service as any).projectEvent(event),
      (service as any).projectEvent(event),
    ]);

    expect(outcomes.sort()).toEqual(['applied', 'duplicate']);
    expect(txRunner.maxActive()).toBe(1);
    expect(actions._store).toHaveLength(2);
    expect(actions._store.map((a: any) => a.actionIndex)).toEqual([0, 1]);
  });

  it('mismatched action arrays are refused before any write', async () => {
    seedActions();
    const event = makeCreatedEvent({
      payload: {
        proposalId: '1',
        targets: [TARGET_A, TARGET_B],
        values: ['0'],
        calldatas: ['0x12345678'],
      } as any,
    });

    await (service as any).projectEvent(event);

    expect(txRunner.run).not.toHaveBeenCalled();
    expect(actions._store).toHaveLength(1);
    expect((actions._store[0] as any).calldata).toBe('0xold');
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

  it('reorg rollback followed by replay restores the exact canonical action set', async () => {
    await seedProposal(ProposalChainState.QUEUED);
    (proposals._store[0] as any).stateChangedAtBlock = '300';
    seedActions('0'.repeat(64));

    const canonical = makeCreatedEvent({
      txHash: '0xcanonical',
      logIndex: 0,
      blockNumber: '100',
    });
    events.createQueryBuilder = jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => canonical),
      getMany: jest.fn(async () => []),
      delete: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn(async () => ({ affected: 0 })),
      })),
    }));

    await service.rollbackAboveBlock(11155420, 250n);

    expect(actions._store).toHaveLength(2);
    expect(actions._store.map((a: any) => a.actionIndex)).toEqual([0, 1]);
    expect(actions._store.map((a: any) => a.calldata)).toEqual([
      '0x12345678',
      '0xabcdef01',
    ]);
    expect(actions._store.every((a: any) => a.calldataChecksum === 'a'.repeat(64))).toBe(true);
    expect((proposals._store[0] as any).createdEventTxHash).toBe('0xcanonical');
    expect((proposals._store[0] as any).actionCount).toBe(2);
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

import {
  CursorInvalidException,
  CursorService,
} from '../../../common/pagination/cursor.service';
import { RoleChange } from '../entities/role-change.entity';
import { GovernanceReadService } from '../governance-read.service';
import {
  buildRoleChangeBinding,
  encodeRoleChangePosition,
} from '../role-change.cursor';

const CHAIN_ID = 10;
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const OTHER_ACCOUNT = '0x4444444444444444444444444444444444444444';
const ROLE = `0x${'01'.repeat(32)}`;
const OTHER_ROLE = `0x${'02'.repeat(32)}`;
const RELEASE = {
  chainId: '10',
  releaseId: 'test-release',
  deploymentBlock: 100,
  artifactChecksum: 'a'.repeat(64),
};

function tx(n: number): string {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

function row(
  blockNumber: string,
  logIndex: number,
  txNumber: number,
  overrides: Partial<RoleChange> = {},
): RoleChange {
  return {
    id: `id-${txNumber}-${logIndex}`,
    chainId: CHAIN_ID,
    contractAddress: '0x2222222222222222222222222222222222222222',
    kind: 'GRANTED',
    role: ROLE,
    account: ACCOUNT,
    sender: '0x3333333333333333333333333333333333333333',
    txHash: tx(txNumber),
    logIndex,
    blockNumber,
    blockTimestamp: null,
    artifactVersion: 'v1',
    createdAt: new Date(),
    ...overrides,
  } as RoleChange;
}

function compareDesc(a: RoleChange, b: RoleChange): number {
  const blockDiff =
    BigInt(a.blockNumber) < BigInt(b.blockNumber)
      ? 1
      : BigInt(a.blockNumber) > BigInt(b.blockNumber)
        ? -1
        : 0;
  if (blockDiff !== 0) return blockDiff;
  if (a.logIndex !== b.logIndex) return b.logIndex - a.logIndex;
  return a.txHash < b.txHash ? 1 : a.txHash > b.txHash ? -1 : 0;
}

function makeRepo(rows: RoleChange[]) {
  const state = {
    filters: [] as { sql: string; params: Record<string, unknown> }[],
    order: [] as string[],
    take: 0,
  };
  const matches = (r: RoleChange, filter: (typeof state.filters)[number]) => {
    const p = filter.params;
    if ('chainId' in p && r.chainId !== p.chainId) return false;
    if ('account' in p && r.account !== p.account) return false;
    if ('role' in p && r.role !== p.role) return false;
    if ('cursorBlockNumber' in p) {
      const block = BigInt(r.blockNumber);
      const cursorBlock = BigInt(String(p.cursorBlockNumber));
      if (block !== cursorBlock) return block < cursorBlock;
      const logIndex = p.cursorLogIndex as number;
      if (r.logIndex !== logIndex) return r.logIndex < logIndex;
      return r.txHash < (p.cursorTxHash as string);
    }
    return true;
  };
  const qb: any = {
    where: jest.fn((sql: string, params?: Record<string, unknown>) => {
      state.filters.push({ sql, params: params ?? {} });
      return qb;
    }),
    andWhere: jest.fn((sql: string, params?: Record<string, unknown>) => {
      state.filters.push({ sql, params: params ?? {} });
      return qb;
    }),
    orderBy: jest.fn((sql: string, direction: string) => {
      state.order.push(`${sql} ${direction}`);
      return qb;
    }),
    addOrderBy: jest.fn((sql: string, direction: string) => {
      state.order.push(`${sql} ${direction}`);
      return qb;
    }),
    take: jest.fn((n: number) => {
      state.take = n;
      return qb;
    }),
    getMany: jest.fn(async () =>
      rows
        .filter((r) => state.filters.every((f) => matches(r, f)))
        .sort(compareDesc)
        .slice(0, state.take),
    ),
  };
  return {
    state,
    createQueryBuilder: jest.fn(() => {
      state.filters = [];
      state.order = [];
      state.take = 0;
      return qb;
    }),
  };
}

describe('GovernanceReadService.listRoleChanges composite cursor', () => {
  let now: number;
  let cursorService: CursorService;

  const makeService = (
    repo: ReturnType<typeof makeRepo>,
    ttlSeconds = 3600,
  ) => {
    now = 1_700_000_000_000;
    cursorService = new CursorService({
      activeKey: { id: 'test-key', secret: 'test-secret' },
      ttlSeconds,
      nowFns: () => now,
    });
    return new GovernanceReadService(
      {} as never,
      {} as never,
      {} as never,
      repo as never,
      () => cursorService,
      () => RELEASE,
    );
  };

  const enumerate = async (
    service: GovernanceReadService,
    params: { account?: string; role?: string; limit?: number } = {},
  ) => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result = await service.listRoleChanges({
        chainId: CHAIN_ID,
        limit: params.limit ?? 2,
        account: params.account,
        role: params.role,
        cursor,
      });
      seen.push(...result.items.map((item) => item.txHash));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return seen;
  };

  it('returns every same-block event exactly once across pages', async () => {
    const rows = [
      row('1000', 3, 3),
      row('1000', 2, 4),
      row('1000', 1, 5),
      row('1000', 0, 6),
    ];
    const repo = makeRepo(rows);
    const service = makeService(repo);

    const seen = await enumerate(service);

    expect(seen).toEqual([tx(3), tx(4), tx(5), tx(6)]);
    expect(new Set(seen).size).toBe(rows.length);
    expect(
      repo.state.filters.some((f) =>
        f.sql.includes('r.logIndex < :cursorLogIndex'),
      ),
    ).toBe(true);
    expect(
      repo.state.filters.some((f) => f.sql.includes('= :cursorBlockNumber')),
    ).toBe(true);
  });

  it('orders across blocks with exact big-integer precision', async () => {
    const rows = [
      row('9007199254740992', 0, 1),
      row('9007199254740993', 0, 2),
      row('99999999999999999999999999', 1, 3),
      row('99999999999999999999999999', 0, 4),
    ];
    const service = makeService(makeRepo(rows));

    const seen = await enumerate(service);
    expect(seen).toEqual([tx(3), tx(4), tx(2), tx(1)]);

    const first = await service.listRoleChanges({
      chainId: CHAIN_ID,
      limit: 1,
    });
    expect(typeof first.items[0].blockNumber).toBe('string');
    expect(first.items[0].blockNumber).toBe('99999999999999999999999999');
  });

  it('breaks ties deterministically when block and log index coincide', async () => {
    const rows = [row('5', 7, 1), row('5', 7, 2)];
    const service = makeService(makeRepo(rows));

    expect(await enumerate(service, { limit: 1 })).toEqual([tx(2), tx(1)]);
  });

  it('binds account and role filters so they cannot change between pages', async () => {
    const rows = [
      row('7', 1, 1),
      row('7', 0, 2),
      row('6', 0, 5),
      row('7', 1, 3, { account: OTHER_ACCOUNT }),
      row('7', 1, 4, { role: OTHER_ROLE }),
    ];
    const repo = makeRepo(rows);
    const service = makeService(repo);
    const first = await service.listRoleChanges({
      chainId: CHAIN_ID,
      account: ACCOUNT,
      role: ROLE,
      limit: 1,
    });

    await expect(
      service.listRoleChanges({
        chainId: CHAIN_ID,
        account: OTHER_ACCOUNT,
        role: ROLE,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow(CursorInvalidException);
    await expect(
      service.listRoleChanges({
        chainId: CHAIN_ID,
        account: ACCOUNT,
        role: OTHER_ROLE,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow(CursorInvalidException);
    const second = await service.listRoleChanges({
      chainId: CHAIN_ID,
      account: ACCOUNT,
      role: ROLE,
      cursor: first.nextCursor,
    });
    expect(second.items[0].txHash).toBe(tx(2));
    expect(second.items[1].txHash).toBe(tx(5));
    expect(repo.state.filters.some((f) => f.params.account === ACCOUNT)).toBe(
      true,
    );
  });

  it('rejects tampered, wrong-route, wrong-chain and legacy cursors', async () => {
    const service = makeService(makeRepo([row('10', 1, 1), row('10', 0, 2)]));
    const first = await service.listRoleChanges({
      chainId: CHAIN_ID,
      limit: 1,
    });
    const cursor = first.nextCursor!;

    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`;
    await expect(
      service.listRoleChanges({ chainId: CHAIN_ID, cursor: tampered }),
    ).rejects.toThrow(CursorInvalidException);

    const wrongRoute = cursorService.encode({
      ...buildRoleChangeBinding({ chainId: CHAIN_ID }, RELEASE),
      route: 'v2:governance:proposals',
      position: encodeRoleChangePosition({
        blockNumber: '10',
        logIndex: 1,
        txHash: tx(1),
      }),
    });
    await expect(
      service.listRoleChanges({ chainId: CHAIN_ID, cursor: wrongRoute }),
    ).rejects.toThrow(CursorInvalidException);

    await expect(
      service.listRoleChanges({ chainId: 8453, cursor }),
    ).rejects.toThrow(CursorInvalidException);

    await expect(
      service.listRoleChanges({ chainId: CHAIN_ID, cursor: '1000' }),
    ).rejects.toThrow(CursorInvalidException);
  });

  it('rejects expired cursors', async () => {
    const service = makeService(
      makeRepo([row('10', 1, 1), row('10', 0, 2)]),
      1,
    );
    const first = await service.listRoleChanges({
      chainId: CHAIN_ID,
      limit: 1,
    });

    now += 2_000;
    await expect(
      service.listRoleChanges({ chainId: CHAIN_ID, cursor: first.nextCursor }),
    ).rejects.toThrow(CursorInvalidException);
  });

  it('has no gaps or duplicates over a mixed unchanged dataset', async () => {
    const rows = [
      row('20', 4, 1),
      row('20', 3, 2),
      row('19', 1, 3),
      row('19', 0, 4),
      row('18', 2, 5),
      row('18', 2, 6),
      row('17', 0, 7),
    ];
    const service = makeService(makeRepo(rows));

    for (const limit of [1, 2, 3]) {
      const seen = await enumerate(service, { limit });
      expect(seen).toEqual(
        rows
          .slice()
          .sort(compareDesc)
          .map((r) => r.txHash),
      );
      expect(new Set(seen).size).toBe(rows.length);
    }
  });
});

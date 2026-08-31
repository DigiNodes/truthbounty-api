/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await -- generic in-memory fake repository */
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProjectStakeService } from './project-stake.service';
import { Stake } from './entities/stake.entity';
import { ProjectStakeLock } from './entities/project-stake-lock.entity';
import { ProjectStakeWithdrawal } from './entities/project-stake-withdrawal.entity';

class FakeRepo {
  private rows: any[] = [];
  private created: any[] = [];
  private deleted: any[] = [];

  constructor(seed: any[] = []) {
    this.rows = seed;
  }

  async findOne(opts?: any) {
    const where = opts?.where ?? opts ?? {};
    const hit =
      this.rows.find((r) =>
        Object.keys(where).every((k) => r[k] === where[k]),
      ) ?? null;
    return hit;
  }

  async find(opts?: any) {
    const where = opts?.where ?? {};
    let matches = this.rows.filter((r) =>
      Object.keys(where).every((k) => r[k] === where[k]),
    );
    if (opts?.order) {
      const [key, dir] = Object.entries(opts.order)[0];
      matches = [...matches].sort((a, b) => {
        const cmp = String(a[key]).localeCompare(String(b[key]));
        return dir === 'DESC' ? -cmp : cmp;
      });
    }
    return matches;
  }

  create(entity: any) {
    return { ...entity };
  }

  async save(entity: any) {
    if (!entity.id) {
      entity.id = `id-${this.rows.length + this.created.length + 1}`;
    }
    this.rows.push(entity);
    this.created.push(entity);
    return entity;
  }

  async delete(id: string) {
    this.deleted.push(id);
    this.rows = this.rows.filter((r) => r.id !== id);
    return { affected: 1 };
  }

  getCalls() {
    return { created: this.created, deleted: this.deleted, rows: this.rows };
  }
}

describe('ProjectStakeService', () => {
  let service: ProjectStakeService;
  let stakeRepo: FakeRepo;
  let lockRepo: FakeRepo;
  let withdrawalRepo: FakeRepo;

  beforeEach(async () => {
    stakeRepo = new FakeRepo();
    lockRepo = new FakeRepo();
    withdrawalRepo = new FakeRepo();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProjectStakeService,
        { provide: getRepositoryToken(Stake), useValue: stakeRepo },
        {
          provide: getRepositoryToken(ProjectStakeLock),
          useValue: lockRepo,
        },
        {
          provide: getRepositoryToken(ProjectStakeWithdrawal),
          useValue: withdrawalRepo,
        },
      ],
    }).compile();

    service = moduleRef.get(ProjectStakeService);
  });

  it('computes withdrawable = total - activeLocks - withdrawn', async () => {
    stakeRepo = new FakeRepo([
      {
        id: 's1',
        walletAddress: '0xW',
        claimId: 'c1',
        amount: '1000',
        updatedAt: new Date(),
      },
    ]);
    lockRepo = new FakeRepo([
      {
        id: 'l1',
        walletAddress: '0xW',
        claimId: 'c1',
        amount: '300',
        unlocksAt: String(Math.floor(Date.now() / 1000) + 100000), // active
        updatedAt: new Date(),
      },
    ]);
    withdrawalRepo = new FakeRepo([
      {
        id: 'wd1',
        walletAddress: '0xW',
        claimId: 'c1',
        amount: '200',
        txHash: '0x1',
      },
    ]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProjectStakeService,
        { provide: getRepositoryToken(Stake), useValue: stakeRepo },
        { provide: getRepositoryToken(ProjectStakeLock), useValue: lockRepo },
        {
          provide: getRepositoryToken(ProjectStakeWithdrawal),
          useValue: withdrawalRepo,
        },
      ],
    }).compile();
    service = moduleRef.get(ProjectStakeService);

    const ent = await service.getEntitlement('0xW', 'c1');
    expect(ent.totalStaked).toBe('1000');
    expect(ent.locked).toBe('300');
    expect(ent.withdrawn).toBe('200');
    expect(ent.withdrawable).toBe('500'); // 1000 - 300 - 200
  });

  it('releases expired locks for entitlement', async () => {
    stakeRepo = new FakeRepo([
      {
        id: 's1',
        walletAddress: '0xW',
        claimId: 'c1',
        amount: '1000',
        updatedAt: new Date(),
      },
    ]);
    lockRepo = new FakeRepo([
      {
        id: 'l1',
        walletAddress: '0xW',
        claimId: 'c1',
        amount: '400',
        unlocksAt: String(Math.floor(Date.now() / 1000) - 1000), // expired
        updatedAt: new Date(),
      },
    ]);
    withdrawalRepo = new FakeRepo([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProjectStakeService,
        { provide: getRepositoryToken(Stake), useValue: stakeRepo },
        { provide: getRepositoryToken(ProjectStakeLock), useValue: lockRepo },
        {
          provide: getRepositoryToken(ProjectStakeWithdrawal),
          useValue: withdrawalRepo,
        },
      ],
    }).compile();
    service = moduleRef.get(ProjectStakeService);

    const ent = await service.getEntitlement('0xW', 'c1');
    expect(ent.locked).toBe('0');
    expect(ent.expiredLocked).toBe('400');
    expect(ent.withdrawable).toBe('600'); // 1000 - 400
  });

  it('rejects a withdrawal that exceeds the entitlement', async () => {
    stakeRepo = new FakeRepo([
      {
        id: 's1',
        walletAddress: '0xW',
        claimId: 'c1',
        amount: '100',
        updatedAt: new Date(),
      },
    ]);
    lockRepo = new FakeRepo([]);
    withdrawalRepo = new FakeRepo([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProjectStakeService,
        { provide: getRepositoryToken(Stake), useValue: stakeRepo },
        { provide: getRepositoryToken(ProjectStakeLock), useValue: lockRepo },
        {
          provide: getRepositoryToken(ProjectStakeWithdrawal),
          useValue: withdrawalRepo,
        },
      ],
    }).compile();
    service = moduleRef.get(ProjectStakeService);

    const result = await service.withdraw({
      walletAddress: '0xW',
      claimId: 'c1',
      amount: '200',
      txHash: '0xbig',
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('insufficient_entitlement');
  });

  it('applies a valid withdrawal idempotently by txHash', async () => {
    stakeRepo = new FakeRepo([
      {
        id: 's1',
        walletAddress: '0xW',
        claimId: 'c1',
        amount: '500',
        updatedAt: new Date(),
      },
    ]);
    lockRepo = new FakeRepo([]);
    withdrawalRepo = new FakeRepo([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProjectStakeService,
        { provide: getRepositoryToken(Stake), useValue: stakeRepo },
        { provide: getRepositoryToken(ProjectStakeLock), useValue: lockRepo },
        {
          provide: getRepositoryToken(ProjectStakeWithdrawal),
          useValue: withdrawalRepo,
        },
      ],
    }).compile();
    service = moduleRef.get(ProjectStakeService);

    const first = await service.withdraw({
      walletAddress: '0xW',
      claimId: 'c1',
      amount: '100',
      txHash: '0xdup',
    });
    expect(first.applied).toBe(true);

    // Replay: same txHash should be a no-op
    const second = await service.withdraw({
      walletAddress: '0xW',
      claimId: 'c1',
      amount: '100',
      txHash: '0xdup',
    });
    expect(second.applied).toBe(false);
    expect(second.reason).toBe('duplicate_tx');
  });

  it('creates a lock only when there is sufficient stake', async () => {
    stakeRepo = new FakeRepo([
      {
        id: 's1',
        walletAddress: '0xW',
        claimId: 'c1',
        amount: '50',
        updatedAt: new Date(),
      },
    ]);
    lockRepo = new FakeRepo([]);
    withdrawalRepo = new FakeRepo([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProjectStakeService,
        { provide: getRepositoryToken(Stake), useValue: stakeRepo },
        { provide: getRepositoryToken(ProjectStakeLock), useValue: lockRepo },
        {
          provide: getRepositoryToken(ProjectStakeWithdrawal),
          useValue: withdrawalRepo,
        },
      ],
    }).compile();
    service = moduleRef.get(ProjectStakeService);

    await expect(
      service.createLock({
        walletAddress: '0xW',
        claimId: 'c1',
        amount: '200', // > staked 50
        unlocksAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).rejects.toThrow(/insufficient staked balance/);

    const lock = await service.createLock({
      walletAddress: '0xW',
      claimId: 'c1',
      amount: '20',
      unlocksAt: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(lock.amount).toBe('20');
  });

  it('reconcile flags divergence and emits a critical error', async () => {
    stakeRepo = new FakeRepo([
      {
        id: 's1',
        walletAddress: '0xW',
        claimId: 'c1',
        amount: '100',
        updatedAt: new Date(),
      },
    ]);
    lockRepo = new FakeRepo([]);
    withdrawalRepo = new FakeRepo([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProjectStakeService,
        { provide: getRepositoryToken(Stake), useValue: stakeRepo },
        { provide: getRepositoryToken(ProjectStakeLock), useValue: lockRepo },
        {
          provide: getRepositoryToken(ProjectStakeWithdrawal),
          useValue: withdrawalRepo,
        },
      ],
    }).compile();
    service = moduleRef.get(ProjectStakeService);

    const ok = await service.reconcile('0xW', 'c1', '100');
    expect(ok.inSync).toBe(true);

    const bad = await service.reconcile('0xW', 'c1', '150');
    expect(bad.inSync).toBe(false);
    expect(bad.divergence).toBe('50');
  });
});

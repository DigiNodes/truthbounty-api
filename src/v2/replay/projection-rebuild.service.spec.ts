import { ProjectionRebuildService } from './projection-rebuild.service';
import {
  CanonicalEventLike,
  ProjectorAdapter,
  ReplayBinding,
} from './projection-rebuild.types';

const binding: ReplayBinding = {
  chainId: 11155420,
  releaseId: 'v2-sepolia-test',
  deploymentBlock: 100,
  artifactChecksum: 'abc123checksum',
};

function ev(
  over: Partial<CanonicalEventLike> & Pick<CanonicalEventLike, 'id' | 'logIndex' | 'blockNumber'>,
): CanonicalEventLike {
  return {
    chainId: 11155420,
    contractAddress: '0x0000000000000000000000000000000000000001',
    artifactVersion: '1',
    eventName: 'DisputeRaised',
    txHash: '0x' + 'ab'.repeat(32),
    payload: { claimId: 'c1' },
    ...over,
  };
}

class MemoryProjector implements ProjectorAdapter {
  name = 'test-projector';
  rows: CanonicalEventLike[] = [];
  async apply(event: CanonicalEventLike) {
    const key = `${event.txHash}:${event.logIndex}`;
    if (this.rows.some((r) => `${r.txHash}:${r.logIndex}` === key)) {
      return 'skipped' as const;
    }
    this.rows.push(event);
    return 'applied' as const;
  }
  async snapshot() {
    return this.rows.map((r) => ({
      txHash: r.txHash,
      logIndex: r.logIndex,
      blockNumber: r.blockNumber,
      eventName: r.eventName,
    }));
  }
  async reset() {
    this.rows = [];
  }
}

class MemorySource {
  constructor(private events: CanonicalEventLike[]) {}
  async readFrom(
    _b: ReplayBinding,
    after: { lastBlockNumber: string; lastLogIndex: number } | null,
    limit: number,
  ) {
    let list = [...this.events].sort((a, b) => {
      const bn = Number(a.blockNumber) - Number(b.blockNumber);
      return bn !== 0 ? bn : a.logIndex - b.logIndex;
    });
    if (after) {
      list = list.filter((e) => {
        const bn = Number(e.blockNumber);
        const ab = Number(after.lastBlockNumber);
        return bn > ab || (bn === ab && e.logIndex > after.lastLogIndex);
      });
    }
    return list.slice(0, limit);
  }
}

describe('ProjectionRebuildService (#597)', () => {
  const stream = [
    ev({ id: '1', blockNumber: '100', logIndex: 0 }),
    ev({ id: '2', blockNumber: '101', logIndex: 0, txHash: '0x' + 'cd'.repeat(32) }),
  ];

  it('same event stream twice yields identical digests', async () => {
    const p1 = new MemoryProjector();
    const s1 = new ProjectionRebuildService(new MemorySource(stream), [p1]);
    const r1 = await s1.run({
      mode: 'rebuild',
      binding,
      targetSchema: 'replay_shadow',
    });

    const p2 = new MemoryProjector();
    const s2 = new ProjectionRebuildService(new MemorySource(stream), [p2]);
    const r2 = await s2.run({
      mode: 'rebuild',
      binding,
      targetSchema: 'replay_shadow',
    });

    expect(r1.errors).toEqual([]);
    expect(r1.digests).toEqual(r2.digests);
    expect(r1.digests[0].rowCount).toBe(2);
  });

  it('interrupted replay can resume from checkpoint', async () => {
    const projector = new MemoryProjector();
    const source = new MemorySource(stream);
    const svc = new ProjectionRebuildService(source, [projector]);

    // First only process by using batchSize 1 then resume
    const partial = await svc.run({
      mode: 'rebuild',
      binding,
      targetSchema: 'replay_shadow',
      batchSize: 1,
      maxBatches: 1,
    });
    expect(partial.checkpoint?.lastEventId).toBe('1');

    const resumed = await svc.run({
      mode: 'resume',
      binding,
      targetSchema: 'replay_shadow',
      checkpoint: partial.checkpoint,
      batchSize: 10,
    });
    expect(resumed.checkpoint?.lastEventId).toBe('2');
    expect(projector.rows).toHaveLength(2);
  });

  it('malformed event is reported fail-closed without throwing secrets', async () => {
    const bad = [
      ev({ id: '1', blockNumber: '100', logIndex: 0, eventName: '', txHash: '0xbad' }),
    ];
    const svc = new ProjectionRebuildService(new MemorySource(bad), [
      new MemoryProjector(),
    ]);
    const report = await svc.run({
      mode: 'rebuild',
      binding,
      targetSchema: 'replay_shadow',
    });
    expect(report.errors.some((e) => e.includes('malformed'))).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/privateKey|mnemonic/i);
  });

  it('unavailable RPC fails closed', async () => {
    const svc = new ProjectionRebuildService(new MemorySource(stream), [
      new MemoryProjector(),
    ]);
    const report = await svc.run({
      mode: 'rebuild',
      binding,
      targetSchema: 'replay_shadow',
      rpcAvailable: false,
    });
    expect(report.errors[0]).toMatch(/RPC unavailable/);
    expect(report.eventsApplied).toBe(0);
  });

  it('production schema protected from direct rebuild', async () => {
    const svc = new ProjectionRebuildService(new MemorySource(stream), [
      new MemoryProjector(),
    ]);
    const report = await svc.run({
      mode: 'rebuild',
      binding,
      targetSchema: 'production',
    });
    expect(report.errors.some((e) => e.includes('protected'))).toBe(true);
  });

  it('dry-run does not apply projector writes', async () => {
    const projector = new MemoryProjector();
    const svc = new ProjectionRebuildService(new MemorySource(stream), [
      projector,
    ]);
    const report = await svc.run({
      mode: 'dry-run',
      binding,
      targetSchema: 'replay_shadow',
    });
    expect(report.dryRun).toBe(true);
    expect(projector.rows).toHaveLength(0);
    expect(report.eventsRead).toBe(2);
  });

  it('cutover requires matching digests and explicit confirm', async () => {
    const p = new MemoryProjector();
    const svc = new ProjectionRebuildService(new MemorySource(stream), [p]);
    await svc.run({ mode: 'rebuild', binding, targetSchema: 'replay_shadow' });
    const digests = (
      await svc.run({ mode: 'verify', binding, targetSchema: 'replay_shadow' })
    ).digests;

    const denied = await svc.run({
      mode: 'cutover',
      binding,
      targetSchema: 'production',
      expectedDigests: digests,
      confirmCutover: false,
    });
    expect(denied.cutoverApplied).toBe(false);

    const ok = await svc.run({
      mode: 'cutover',
      binding,
      targetSchema: 'production',
      expectedDigests: digests,
      confirmCutover: true,
    });
    expect(ok.digestsMatch).toBe(true);
    expect(ok.cutoverApplied).toBe(true);
  });
});

import { register } from 'prom-client';
import { FinalizedCursorService } from './finalized-cursor.service';
import {
  CanonicalEvent,
  FinalizedCursorError,
  ReleaseBinding,
} from './finalized-cursor.types';
import {
  InMemoryFinalizedCursorStore,
  InMemoryProjectionHandle,
} from './testing/in-memory-finalized-cursor.store';

const CHECKSUM = 'a'.repeat(64);
const binding: ReleaseBinding = {
  chainId: 11155420,
  releaseId: 'v2.0.0-sepolia',
  deploymentBlock: 100n,
  artifactChecksum: CHECKSUM,
};
const hash = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const policy = { maxIndexLagBlocks: 10, maxHeadAgeMs: 60_000 };

function makeService(store: InMemoryFinalizedCursorStore) {
  return new FinalizedCursorService<InMemoryProjectionHandle>(store, {
    binding,
    policy,
  });
}

/** Deterministic canonical event stream: two events every third block. */
function canonicalEvents(from: bigint, to: bigint): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  for (let b = from; b <= to; b++) {
    if (b % 3n !== 0n) continue;
    for (const logIndex of [0, 1]) {
      events.push({
        chainId: binding.chainId,
        releaseId: binding.releaseId,
        blockNumber: b,
        blockHash: hash(b),
        transactionHash: hash(b * 1000n + BigInt(logIndex)),
        logIndex,
      });
    }
  }
  return events;
}

const writeAll = async (
  handle: InMemoryProjectionHandle,
  events: readonly CanonicalEvent[],
) => {
  for (const e of events) handle.write(e);
};

/**
 * Minimal indexer driver: resumes from the persisted watermark and applies
 * fixed-size finalized batches, exactly as a restarted process would.
 */
async function runIndexer(
  service: FinalizedCursorService<InMemoryProjectionHandle>,
  finalized: bigint,
  opts: {
    batchSize?: bigint;
    maxBatches?: number;
    effects?: typeof writeAll;
  } = {},
) {
  const batchSize = opts.batchSize ?? 7n;
  await service.initialize(binding);
  await service.recordHeads(binding, {
    observedHead: finalized + 5n,
    safeHead: finalized + 2n,
    finalizedHead: finalized,
    observedAt: new Date(),
  });
  let batches = 0;
  for (;;) {
    if (opts.maxBatches !== undefined && batches >= opts.maxBatches) return;
    const status = await service.getStatus(binding);
    const watermark = BigInt(status.indexedWatermark!);
    if (watermark >= finalized) return;
    const from = watermark + 1n;
    const to =
      from + batchSize - 1n > finalized ? finalized : from + batchSize - 1n;
    await service.applyFinalizedRange(
      binding,
      {
        fromBlock: from,
        toBlock: to,
        toBlockHash: hash(to),
        events: canonicalEvents(from, to),
      },
      opts.effects ?? writeAll,
    );
    batches++;
  }
}

function expectExactlyOnce(store: InMemoryFinalizedCursorStore, to: bigint) {
  const expected = canonicalEvents(binding.deploymentBlock, to);
  expect(store.projection.size).toBe(expected.length);
  for (const count of store.projection.values()) expect(count).toBe(1);
}

describe('FinalizedCursorService (PREWAVE-BE-001)', () => {
  afterEach(() => register.resetMetrics());

  describe('initialization and release binding', () => {
    it('creates one cursor at deploymentBlock - 1 and is idempotent', async () => {
      const store = new InMemoryFinalizedCursorStore();
      const service = makeService(store);
      const first = await service.initialize(binding);
      const second = await service.initialize(binding);
      expect(first.indexedWatermark).toBe(99n);
      expect(second.indexedWatermark).toBe(99n);
      expect(first.finalizedHead).toBeNull();
    });

    it.each([
      ['artifact checksum', { artifactChecksum: 'b'.repeat(64) }],
      ['deployment block', { deploymentBlock: 50n }],
    ])('fails closed on a wrong-release %s', async (_label, override) => {
      const store = new InMemoryFinalizedCursorStore();
      await makeService(store).initialize(binding);
      const wrong = { ...binding, ...override };
      await expect(makeService(store).initialize(wrong)).rejects.toMatchObject({
        code: 'WRONG_RELEASE',
      });
      await expect(
        makeService(store).recordHeads(wrong, {
          observedHead: 200n,
          safeHead: 200n,
          finalizedHead: 200n,
          observedAt: new Date(),
        }),
      ).rejects.toMatchObject({ code: 'WRONG_RELEASE' });
      const status = await makeService(store).getStatus(wrong);
      expect(status.ready).toBe(false);
      expect(status.reasons).toContain('WRONG_RELEASE');
    });

    it('rejects malformed bindings', async () => {
      const service = makeService(new InMemoryFinalizedCursorStore());
      await expect(
        service.initialize({ ...binding, artifactChecksum: 'not-a-checksum' }),
      ).rejects.toMatchObject({ code: 'INVALID_BINDING' });
      await expect(
        service.initialize({ ...binding, chainId: 0 }),
      ).rejects.toMatchObject({ code: 'INVALID_BINDING' });
    });

    it('rejects events decoded for a different release or chain', async () => {
      const store = new InMemoryFinalizedCursorStore();
      const service = makeService(store);
      await runIndexer(service, 110n, { maxBatches: 0 });
      const [event] = canonicalEvents(102n, 102n);
      for (const bad of [
        { ...event, releaseId: 'v1.9.0' },
        { ...event, chainId: 10 },
      ]) {
        await expect(
          service.applyFinalizedRange(
            binding,
            {
              fromBlock: 100n,
              toBlock: 105n,
              toBlockHash: hash(105n),
              events: [bad],
            },
            writeAll,
          ),
        ).rejects.toMatchObject({ code: 'WRONG_RELEASE' });
      }
      expect(store.projection.size).toBe(0);
    });
  });

  describe('heads', () => {
    it('keeps observed, safe, finalized and indexed boundaries separate', async () => {
      const store = new InMemoryFinalizedCursorStore();
      const service = makeService(store);
      await runIndexer(service, 120n);
      const status = await service.getStatus(binding);
      expect(status).toMatchObject({
        observedHead: 125,
        safeHead: 122,
        finalizedHead: 120,
        indexedWatermark: 120,
        finalityLagBlocks: 5,
        indexLagBlocks: 0,
        ready: true,
      });
    });

    it('rejects inconsistent heads', async () => {
      const service = makeService(new InMemoryFinalizedCursorStore());
      await service.initialize(binding);
      await expect(
        service.recordHeads(binding, {
          observedHead: 100n,
          safeHead: 110n,
          finalizedHead: 105n,
          observedAt: new Date(),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_HEADS' });
    });

    it('never regresses heads when the provider lags, and lets freshness decay', async () => {
      const store = new InMemoryFinalizedCursorStore();
      const service = makeService(store);
      await service.initialize(binding);
      const t0 = new Date('2026-10-16T00:00:00Z');
      await service.recordHeads(binding, {
        observedHead: 300n,
        safeHead: 290n,
        finalizedHead: 280n,
        observedAt: t0,
      });

      const lagging = await service.recordHeads(binding, {
        observedHead: 310n,
        safeHead: 295n,
        finalizedHead: 270n,
        observedAt: new Date(t0.getTime() + 30_000),
      });
      expect(lagging).toEqual({ accepted: false, reason: 'PROVIDER_LAG' });

      const record = await store.read(binding.chainId, binding.releaseId);
      expect(record!.finalizedHead).toBe(280n);
      expect(record!.headsObservedAt).toEqual(t0);

      const later = await service.getStatus(
        binding,
        new Date(t0.getTime() + 61_000),
      );
      expect(later.ready).toBe(false);
      expect(later.reasons).toContain('HEADS_STALE');
    });

    it('observes heads from a provider and rejects a provider on the wrong chain', async () => {
      const service = makeService(new InMemoryFinalizedCursorStore());
      await service.initialize(binding);
      const blocks = { latest: 500, safe: 480, finalized: 450 };
      const provider = {
        getNetwork: async () => ({ chainId: BigInt(binding.chainId) }),
        getBlock: async (tag: keyof typeof blocks) => ({ number: blocks[tag] }),
      };
      await expect(
        service.observeHeadsFromProvider(binding, provider),
      ).resolves.toEqual({
        accepted: true,
      });

      const wrongChain = {
        ...provider,
        getNetwork: async () => ({ chainId: 10n }),
      };
      await expect(
        service.observeHeadsFromProvider(binding, wrongChain),
      ).rejects.toMatchObject({ code: 'WRONG_RELEASE' });

      const missingFinalized = { ...provider, getBlock: async () => null };
      await expect(
        service.observeHeadsFromProvider(binding, missingFinalized),
      ).rejects.toMatchObject({ code: 'INVALID_HEADS' });
    });
  });

  describe('range application', () => {
    async function ready(finalized = 140n) {
      const store = new InMemoryFinalizedCursorStore();
      const service = makeService(store);
      await runIndexer(service, finalized, { maxBatches: 0 });
      return { store, service };
    }

    it('treats a fully replayed range as a duplicate with no effects', async () => {
      const { store, service } = await ready();
      const range = {
        fromBlock: 100n,
        toBlock: 110n,
        toBlockHash: hash(110n),
        events: canonicalEvents(100n, 110n),
      };
      await service.applyFinalizedRange(binding, range, writeAll);
      const effects = jest.fn(writeAll);
      await expect(
        service.applyFinalizedRange(binding, range, effects),
      ).resolves.toEqual({
        status: 'duplicate',
        indexedWatermark: 110n,
      });
      expect(effects).not.toHaveBeenCalled();
      expectExactlyOnce(store, 110n);
    });

    it('rejects a gap', async () => {
      const { service } = await ready();
      await expect(
        service.applyFinalizedRange(
          binding,
          {
            fromBlock: 105n,
            toBlock: 110n,
            toBlockHash: hash(110n),
            events: [],
          },
          writeAll,
        ),
      ).rejects.toMatchObject({ code: 'GAP' });
    });

    it('rejects a partial overlap with the watermark', async () => {
      const { service } = await ready();
      await service.applyFinalizedRange(
        binding,
        { fromBlock: 100n, toBlock: 110n, toBlockHash: hash(110n), events: [] },
        writeAll,
      );
      await expect(
        service.applyFinalizedRange(
          binding,
          {
            fromBlock: 108n,
            toBlock: 115n,
            toBlockHash: hash(115n),
            events: [],
          },
          writeAll,
        ),
      ).rejects.toMatchObject({ code: 'OVERLAP' });
    });

    it('rejects out-of-order and duplicate events', async () => {
      const { store, service } = await ready();
      const events = canonicalEvents(100n, 110n);
      const swapped = [events[1], events[0], ...events.slice(2)];
      await expect(
        service.applyFinalizedRange(
          binding,
          {
            fromBlock: 100n,
            toBlock: 110n,
            toBlockHash: hash(110n),
            events: swapped,
          },
          writeAll,
        ),
      ).rejects.toMatchObject({ code: 'OUT_OF_ORDER' });
      await expect(
        service.applyFinalizedRange(
          binding,
          {
            fromBlock: 100n,
            toBlock: 110n,
            toBlockHash: hash(110n),
            events: [events[0], events[0]],
          },
          writeAll,
        ),
      ).rejects.toMatchObject({ code: 'DUPLICATE_EVENT' });
      expect(store.projection.size).toBe(0);
    });

    it('never indexes past the finalized head', async () => {
      const { service } = await ready(105n);
      await expect(
        service.applyFinalizedRange(
          binding,
          {
            fromBlock: 100n,
            toBlock: 106n,
            toBlockHash: hash(106n),
            events: [],
          },
          writeAll,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FINALIZED' });
    });

    it('requires an initialized cursor', async () => {
      const service = makeService(new InMemoryFinalizedCursorStore());
      await expect(
        service.applyFinalizedRange(
          binding,
          {
            fromBlock: 100n,
            toBlock: 101n,
            toBlockHash: hash(101n),
            events: [],
          },
          writeAll,
        ),
      ).rejects.toBeInstanceOf(FinalizedCursorError);
    });

    it('rolls back effects when the watermark compare-and-set loses', async () => {
      const { store } = await ready();
      // Wrap the store so a competing writer always wins the CAS.
      const losingStore = {
        read: store.read.bind(store),
        transaction: <T>(fn: Parameters<typeof store.transaction<T>>[0]) =>
          store.transaction<T>((tx) =>
            fn({ ...tx, advanceWatermark: async () => false }),
          ),
      };
      const service = new FinalizedCursorService<InMemoryProjectionHandle>(
        losingStore,
        { binding, policy },
      );
      await expect(
        service.applyFinalizedRange(
          binding,
          {
            fromBlock: 100n,
            toBlock: 110n,
            toBlockHash: hash(110n),
            events: canonicalEvents(100n, 110n),
          },
          writeAll,
        ),
      ).rejects.toMatchObject({ code: 'CONCURRENT_UPDATE' });
      expect(store.projection.size).toBe(0);
      expect(
        (await store.read(binding.chainId, binding.releaseId))!
          .indexedWatermark,
      ).toBe(99n);
    });
  });

  describe('restart at every boundary', () => {
    const FINALIZED = 160n;
    const BATCHES = Number(
      (FINALIZED - binding.deploymentBlock + 1n + 6n) / 7n,
    );
    const faultPoints = [
      'lockCursor',
      'updateHeads',
      'advanceWatermark',
      'commit',
    ] as const;

    it('baseline: an uninterrupted run projects every canonical event once', async () => {
      const store = new InMemoryFinalizedCursorStore();
      await runIndexer(makeService(store), FINALIZED);
      expectExactlyOnce(store, FINALIZED);
    });

    it('recovers from a crash while creating the cursor', async () => {
      const store = new InMemoryFinalizedCursorStore();
      store.failNext('insertCursor');
      await expect(runIndexer(makeService(store), FINALIZED)).rejects.toThrow(
        'simulated crash',
      );
      expect(await store.read(binding.chainId, binding.releaseId)).toBeNull();
      await runIndexer(makeService(store), FINALIZED);
      expectExactlyOnce(store, FINALIZED);
    });

    for (const point of faultPoints) {
      for (let batch = 0; batch <= BATCHES; batch++) {
        it(`crash at ${point} after ${batch} committed batches`, async () => {
          const store = new InMemoryFinalizedCursorStore();
          await runIndexer(makeService(store), FINALIZED, {
            maxBatches: batch,
          });
          const before = await store.read(binding.chainId, binding.releaseId);

          store.failNext(point);
          const crashed = await runIndexer(makeService(store), FINALIZED).then(
            () => false,
            () => true,
          );
          // Every pass touches lockCursor/updateHeads/commit; advanceWatermark
          // is only reached while there is still a batch left to apply.
          const work = before!.indexedWatermark < FINALIZED;
          expect(crashed).toBe(point === 'advanceWatermark' ? work : true);

          const after = await store.read(binding.chainId, binding.releaseId);
          expect(after!.indexedWatermark >= before!.indexedWatermark).toBe(
            true,
          );

          // Restart: a brand-new service instance resumes from persisted state.
          await runIndexer(makeService(store), FINALIZED);
          const final = await store.read(binding.chainId, binding.releaseId);
          expect(final!.indexedWatermark).toBe(FINALIZED);
          expectExactlyOnce(store, FINALIZED);
        });
      }
    }

    for (let batch = 0; batch < BATCHES; batch++) {
      it(`crash midway through projection effects in batch ${batch + 1}`, async () => {
        const store = new InMemoryFinalizedCursorStore();
        await runIndexer(makeService(store), FINALIZED, { maxBatches: batch });
        const committed = store.projection.size;

        await expect(
          runIndexer(makeService(store), FINALIZED, {
            effects: async (handle, events) => {
              if (events.length > 0) handle.write(events[0]);
              throw new Error('simulated crash in effects');
            },
          }),
        ).rejects.toThrow('simulated crash in effects');
        expect(store.projection.size).toBe(committed);

        await runIndexer(makeService(store), FINALIZED);
        expectExactlyOnce(store, FINALIZED);
      });
    }
  });

  describe('readiness and metrics', () => {
    it('fails closed when the cursor is missing or heads were never observed', async () => {
      const store = new InMemoryFinalizedCursorStore();
      const service = makeService(store);
      expect((await service.getStatus(binding)).reasons).toEqual([
        'CURSOR_MISSING',
      ]);
      await service.initialize(binding);
      const status = await service.getStatus(binding);
      expect(status.ready).toBe(false);
      expect(status.reasons).toEqual(['HEADS_NEVER_OBSERVED']);
    });

    it('fails readiness when index lag exceeds policy', async () => {
      const store = new InMemoryFinalizedCursorStore();
      const service = makeService(store);
      await runIndexer(service, 130n, { maxBatches: 1 });
      const status = await service.getStatus(binding);
      expect(status.indexLagBlocks).toBe(24);
      expect(status.ready).toBe(false);
      expect(status.reasons).toEqual(['INDEX_LAG_EXCEEDED']);
    });

    it('returns null status when no binding is configured', async () => {
      const service = new FinalizedCursorService(
        new InMemoryFinalizedCursorStore(),
      );
      expect(service.isConfigured()).toBe(false);
      await expect(service.getConfiguredStatus()).resolves.toBeNull();
    });

    it('labels metrics by chain, release and boundary only', async () => {
      const store = new InMemoryFinalizedCursorStore();
      const service = makeService(store);
      await runIndexer(service, 120n);
      await service.getStatus(binding);
      const text = await register.metrics();
      expect(text).toContain(
        'indexer_finalized_cursor_block{chain_id="11155420",release_id="v2.0.0-sepolia",boundary="indexed"} 120',
      );
      expect(text).toContain(
        'indexer_finalized_cursor_ready{chain_id="11155420",release_id="v2.0.0-sepolia"} 1',
      );
      expect(text).not.toContain(CHECKSUM);
    });
  });
});

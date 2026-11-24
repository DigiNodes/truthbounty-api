import {
  DivergenceKind,
  QuorumProvider,
  QuorumSignal,
} from '../interfaces';
import { ProviderQuarantineStore } from '../provider-quarantine.store';
import { RpcProviderQuorumService } from '../rpc-provider-quorum.service';

function makeProvider(
  id: string,
  behavior: (signal: QuorumSignal) => Promise<unknown> | unknown,
): QuorumProvider {
  return {
    id,
    sanitizedUrl: `https://${id}.rpc.example`,
    observe: async (signal) => behavior(signal),
  };
}

describe('RpcProviderQuorumService', () => {
  let store: ProviderQuarantineStore;
  let service: RpcProviderQuorumService;

  beforeEach(() => {
    store = new ProviderQuarantineStore();
    service = new RpcProviderQuorumService(store);
    service.setPolicy({
      minAgreement: 2,
      maxProviders: 5,
      maxHeadLagBlocks: 8,
      timeoutMs: 200,
      quarantineMs: 60_000,
      recoveryAgreementsRequired: 2,
    });
  });

  it('accepts the signal when the minimum number of providers agree', async () => {
    const providers = [
      makeProvider('p1', () => 10),
      makeProvider('p2', () => 10),
      makeProvider('p3', () => 10),
    ];
    const verdict = await service.checkSignal(providers, QuorumSignal.CHAIN_ID);
    expect(verdict.accepted).toBe(true);
    expect(verdict.value).toBe(10);
    expect(verdict.agreedProviders).toEqual(['p1', 'p2', 'p3']);
    expect(verdict.divergentProviders).toEqual([]);
  });

  it('rejects and quarantines a provider on the wrong chain', async () => {
    const providers = [
      makeProvider('p1', () => 10),
      makeProvider('p2', () => 10),
      makeProvider('p3', () => 1),
    ];
    const verdict = await service.checkSignal(providers, QuorumSignal.CHAIN_ID);
    expect(verdict.accepted).toBe(true);
    expect(verdict.divergentProviders).toHaveLength(1);
    expect(verdict.divergentProviders[0].kind).toBe(
      DivergenceKind.WRONG_CHAIN,
    );
    expect(store.isQuarantined('p3', service.getPolicy())).toBe(true);
  });

  it('classifies a lagging provider as LAG', async () => {
    const head = 1_000_000n;
    const providers = [
      makeProvider('p1', () => head),
      makeProvider('p2', () => head),
      makeProvider('p3', () => head - 100n),
    ];
    const verdict = await service.checkSignal(
      providers,
      QuorumSignal.FINALIZED_HEAD,
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.divergentProviders[0].kind).toBe(DivergenceKind.LAG);
    expect(store.isQuarantined('p3', service.getPolicy())).toBe(true);
  });

  it('accepts a provider within the maxHeadLagBlocks tolerance', async () => {
    const head = 1_000_000n;
    const providers = [
      makeProvider('p1', () => head),
      makeProvider('p2', () => head),
      makeProvider('p3', () => head - 4n),
    ];
    const verdict = await service.checkSignal(
      providers,
      QuorumSignal.FINALIZED_HEAD,
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.divergentProviders).toEqual([]);
    expect(store.isQuarantined('p3', service.getPolicy())).toBe(false);
  });

  it('classifies a divergent block hash as FORK_DIVERGENCE', async () => {
    const providers = [
      makeProvider('p1', () => '0xaaa'),
      makeProvider('p2', () => '0xaaa'),
      makeProvider('p3', () => '0xbbb'),
    ];
    const verdict = await service.checkSignal(
      providers,
      QuorumSignal.BLOCK_HASH,
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.divergentProviders[0].kind).toBe(
      DivergenceKind.FORK_DIVERGENCE,
    );
    expect(store.isQuarantined('p3', service.getPolicy())).toBe(true);
  });

  it('classifies a timed-out provider as TIMEOUT and quarantines it', async () => {
    const providers = [
      makeProvider('p1', () => '0xaaa'),
      makeProvider('p2', () => '0xaaa'),
      makeProvider(
        'p3',
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve('0xaaa'), 500),
          ),
      ),
    ];
    const verdict = await service.checkSignal(
      providers,
      QuorumSignal.BLOCK_HASH,
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.divergentProviders).toHaveLength(1);
    expect(verdict.divergentProviders[0].kind).toBe(DivergenceKind.TIMEOUT);
    expect(store.isQuarantined('p3', service.getPolicy())).toBe(true);
  });

  it('classifies a rate-limited provider as RATE_LIMITED', async () => {
    const providers = [
      makeProvider('p1', () => '0xaaa'),
      makeProvider('p2', () => '0xaaa'),
      makeProvider('p3', () => {
        throw new Error('429 Too Many Requests');
      }),
    ];
    const verdict = await service.checkSignal(
      providers,
      QuorumSignal.BLOCK_HASH,
    );
    expect(verdict.divergentProviders[0].kind).toBe(
      DivergenceKind.RATE_LIMITED,
    );
    expect(store.isQuarantined('p3', service.getPolicy())).toBe(true);
  });

  it('fails closed when fewer than minAgreement providers are eligible', async () => {
    const providers = [makeProvider('p1', () => 10)];
    const verdict = await service.checkSignal(providers, QuorumSignal.CHAIN_ID);
    expect(verdict.accepted).toBe(false);
    expect(verdict.value).toBeUndefined();
    expect(verdict.agreedProviders).toEqual([]);
  });

  it('fails closed when all providers error out (no majority)', async () => {
    const providers = [
      makeProvider('p1', () => {
        throw new Error('connection refused');
      }),
      makeProvider('p2', () => {
        throw new Error('connection refused');
      }),
      makeProvider('p3', () => {
        throw new Error('connection refused');
      }),
    ];
    const verdict = await service.checkSignal(
      providers,
      QuorumSignal.CHAIN_ID,
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.agreedProviders).toEqual([]);
    expect(verdict.divergentProviders).toHaveLength(3);
    expect(store.isQuarantined('p1', service.getPolicy())).toBe(true);
    expect(store.isQuarantined('p2', service.getPolicy())).toBe(true);
    expect(store.isQuarantined('p3', service.getPolicy())).toBe(true);
  });

  it('requires fresh agreement to release a quarantined provider', async () => {
    const bad = [
      makeProvider('p1', () => 10),
      makeProvider('p2', () => 10),
      makeProvider('p3', () => 1),
    ];
    await service.checkSignal(bad, QuorumSignal.CHAIN_ID);
    expect(store.isQuarantined('p3', service.getPolicy())).toBe(true);

    const rec = store.snapshot().find((r) => r.providerId === 'p3')!;
    rec.quarantinedAt = Date.now() - service.getPolicy().quarantineMs - 1;

    const good = [
      makeProvider('p1', () => 10),
      makeProvider('p2', () => 10),
      makeProvider('p3', () => 10),
    ];

    // Poll 1: p3 observed, agrees, freshAgreements = 1 → still quarantined.
    const v1 = await service.checkSignal(good, QuorumSignal.CHAIN_ID);
    expect(v1.agreedProviders).not.toContain('p3');
    expect(store.isQuarantined('p3', service.getPolicy())).toBe(true);
    expect(
      store.snapshot().find((r) => r.providerId === 'p3')!.freshAgreements,
    ).toBe(1);

    // Poll 2: p3 agrees again → freshAgreements = 2 → released.
    const v2 = await service.checkSignal(good, QuorumSignal.CHAIN_ID);
    expect(v2.agreedProviders).not.toContain('p3'); // release is not retro
    expect(store.isQuarantined('p3', service.getPolicy())).toBe(false);

    // Poll 3: p3 is now eligible and counts in the verdict.
    const v3 = await service.checkSignal(good, QuorumSignal.CHAIN_ID);
    expect(v3.agreedProviders).toContain('p3');
  });

  it('resets fresh agreements when a recovering provider diverges again', async () => {
    const bad = [
      makeProvider('p1', () => 10),
      makeProvider('p2', () => 10),
      makeProvider('p3', () => 1),
    ];
    await service.checkSignal(bad, QuorumSignal.CHAIN_ID);

    const rec = store.snapshot().find((r) => r.providerId === 'p3')!;
    rec.quarantinedAt = Date.now() - service.getPolicy().quarantineMs - 1;

    // Poll 1: p3 agrees → freshAgreements = 1.
    const good = [
      makeProvider('p1', () => 10),
      makeProvider('p2', () => 10),
      makeProvider('p3', () => 10),
    ];
    await service.checkSignal(good, QuorumSignal.CHAIN_ID);
    expect(
      store.snapshot().find((r) => r.providerId === 'p3')!.freshAgreements,
    ).toBe(1);

    // Poll 2: p3 diverges again → reset to 0, still quarantined.
    const diverge = [
      makeProvider('p1', () => 10),
      makeProvider('p2', () => 10),
      makeProvider('p3', () => 1),
    ];
    await service.checkSignal(diverge, QuorumSignal.CHAIN_ID);
    expect(
      store.snapshot().find((r) => r.providerId === 'p3')!.freshAgreements,
    ).toBe(0);
    expect(store.isQuarantined('p3', service.getPolicy())).toBe(true);

    // Poll 3: one fresh agreement alone is NOT enough (needs 2 in a row).
    await service.checkSignal(good, QuorumSignal.CHAIN_ID);
    expect(store.isQuarantined('p3', service.getPolicy())).toBe(true);
    expect(
      store.snapshot().find((r) => r.providerId === 'p3')!.freshAgreements,
    ).toBe(1);
  });

  it('honours maxProviders — never consults more than the bound', async () => {
    service.setPolicy({ maxProviders: 2, minAgreement: 2 });

    const observers: string[] = [];
    const make = (id: string) =>
      makeProvider(id, () => {
        observers.push(id);
        return 10;
      });

    const providers = [
      make('p1'),
      make('p2'),
      make('p3'),
      make('p4'),
      make('p5'),
    ];

    await service.checkSignal(providers, QuorumSignal.CHAIN_ID);
    expect(observers).toHaveLength(2);
    expect(observers).toEqual(['p1', 'p2']);
  });
});

import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { HttpGatewayProvider } from './http-gateway.provider';
import { IpfsProvider } from './ipfs-provider.interface';
import {
  EvidenceBinding,
  IpfsQuorumService,
  ProviderAttempt,
} from './ipfs-quorum.service';

const RAW_CODEC = 0x55;
const binding: EvidenceBinding = {
  chainId: 11155420,
  releaseId: 'release-1',
  deploymentBlock: 100,
  artifactChecksum: 'abc123',
};

async function cidFor(bytes: Uint8Array): Promise<string> {
  return CID.createV1(RAW_CODEC, await sha256.digest(bytes)).toString();
}

function provider(
  id: string,
  impl: IpfsProvider['fetch'],
): IpfsProvider & { calls: number } {
  const p = {
    id,
    calls: 0,
    fetch: (cid: string, o: Parameters<IpfsProvider['fetch']>[1]) => {
      p.calls += 1;
      return impl(cid, o);
    },
  };
  return p;
}

const ok = (bytes: Uint8Array) => () =>
  Promise.resolve({ status: 200, bytes });

describe('IpfsQuorumService', () => {
  const good = new TextEncoder().encode('evidence-bytes');
  const bad = new TextEncoder().encode('tampered-bytes');
  let cid: string;

  beforeAll(async () => {
    cid = await cidFor(good);
  });

  const outcomes = (attempts: ProviderAttempt[]) =>
    attempts.map((a) => `${a.providerId}:${a.outcome}`);

  it('serves verified bytes when quorum agrees', async () => {
    const svc = new IpfsQuorumService(
      [provider('a', ok(good)), provider('b', ok(good))],
      { quorum: 2 },
    );
    const res = await svc.fetchValidated({ cid, binding });
    expect(res.status).toBe('available');
    if (res.status === 'available') {
      expect(res.cid).toBe(cid);
      expect(res.verifiedBy).toEqual(['a', 'b']);
      expect(res.binding).toEqual(binding);
    }
  });

  it('never serves corrupt content', async () => {
    const svc = new IpfsQuorumService([provider('a', ok(bad))], { quorum: 1 });
    const res = await svc.fetchValidated({ cid, binding });
    expect(res.status).toBe('unavailable');
    expect(outcomes(res.attempts)).toEqual(['a:integrity_mismatch']);
  });

  it('excludes an inconsistent gateway and fails over within the bound', async () => {
    const a = provider('a', ok(bad));
    const b = provider('b', ok(good));
    const c = provider('c', ok(good));
    const res = await new IpfsQuorumService([a, b, c], {
      quorum: 2,
      maxAttempts: 3,
    }).fetchValidated({ cid, binding });
    expect(res.status).toBe('available');
    expect(outcomes(res.attempts)).toEqual([
      'a:integrity_mismatch',
      'b:verified',
      'c:verified',
    ]);
  });

  it('bounds failover by maxAttempts', async () => {
    const ps = ['a', 'b', 'c', 'd', 'e'].map((id) => provider(id, ok(bad)));
    const res = await new IpfsQuorumService(ps, {
      quorum: 1,
      maxAttempts: 2,
    }).fetchValidated({ cid, binding });
    expect(res.status).toBe('unavailable');
    expect(ps.reduce((n, p) => n + p.calls, 0)).toBe(2);
  });

  it('does not meet quorum with a single verified provider', async () => {
    const res = await new IpfsQuorumService(
      [provider('a', ok(good)), provider('b', ok(bad))],
      { quorum: 2, maxAttempts: 2 },
    ).fetchValidated({ cid, binding });
    expect(res.status).toBe('unavailable');
    if (res.status === 'unavailable') expect(res.reason).toBe('quorum_not_met');
  });

  it('classifies timeouts', async () => {
    const hang = provider('slow', (_cid, o) => {
      return new Promise((_res, rej) => {
        o.signal.addEventListener('abort', () => rej(new Error('aborted')));
      });
    });
    const res = await new IpfsQuorumService([hang], {
      quorum: 1,
      timeoutMs: 20,
    }).fetchValidated({ cid, binding });
    expect(outcomes(res.attempts)).toEqual(['slow:timeout']);
  });

  it('classifies 429 and rejects redirects', async () => {
    const res = await new IpfsQuorumService(
      [
        provider('rl', () => Promise.resolve({ status: 429, bytes: bad })),
        provider('redir', () => Promise.resolve({ status: 302, bytes: good })),
      ],
      { quorum: 1, maxAttempts: 2 },
    ).fetchValidated({ cid, binding });
    expect(res.status).toBe('unavailable');
    expect(outcomes(res.attempts)).toEqual([
      'rl:rate_limited',
      'redir:redirect_rejected',
    ]);
  });

  it('opens a breaker, isolates the provider, and recovers', async () => {
    let now = 0;
    let healthy = false;
    const flaky = provider('flaky', () =>
      healthy
        ? Promise.resolve({ status: 200, bytes: good })
        : Promise.resolve({ status: 500, bytes: new Uint8Array() }),
    );
    const svc = new IpfsQuorumService([flaky], {
      quorum: 1,
      maxAttempts: 1,
      breakerFailureThreshold: 2,
      breakerCooldownMs: 1000,
      now: () => now,
    });

    await svc.fetchValidated({ cid, binding });
    await svc.fetchValidated({ cid, binding });
    expect(svc.circuitState('flaky')).toBe('open');

    const callsBefore = flaky.calls;
    const blocked = await svc.fetchValidated({ cid, binding });
    expect(flaky.calls).toBe(callsBefore);
    expect(outcomes(blocked.attempts)).toEqual(['flaky:circuit_open']);

    now = 1500;
    healthy = true;
    expect(svc.circuitState('flaky')).toBe('half_open');
    const recovered = await svc.fetchValidated({ cid, binding });
    expect(recovered.status).toBe('available');
    expect(svc.circuitState('flaky')).toBe('closed');
  });

  it('reports all-provider outage explicitly', async () => {
    const down = (id: string) =>
      provider(id, () => Promise.reject(new Error('ECONNREFUSED')));
    const res = await new IpfsQuorumService([down('a'), down('b')], {
      quorum: 1,
      maxAttempts: 2,
    }).fetchValidated({ cid, binding });
    expect(res.status).toBe('unavailable');
    if (res.status === 'unavailable') {
      expect(res.reason).toBe('all_providers_unavailable');
    }
  });

  it('does not let a poisoned provider populate the cache', async () => {
    let serve = bad;
    const p = provider('a', () => Promise.resolve({ status: 200, bytes: serve }));
    const svc = new IpfsQuorumService([p], { quorum: 1, maxAttempts: 1 });
    expect((await svc.fetchValidated({ cid, binding })).status).toBe(
      'unavailable',
    );
    serve = good;
    const res = await svc.fetchValidated({ cid, binding });
    expect(res.status).toBe('available');
    if (res.status === 'available') expect(res.source).toBe('providers');
    const cached = await svc.fetchValidated({ cid, binding });
    if (cached.status === 'available') {
      expect(cached.source).toBe('cache');
      expect(Buffer.from(cached.bytes).equals(Buffer.from(good))).toBe(true);
    }
  });

  it('keeps the canonical CID independent of the gateway URL', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(Buffer.from(good), { status: 200 }),
    );
    const gw = new HttpGatewayProvider(
      'gw',
      'https://gateway.example/',
      fetchImpl as unknown as typeof fetch,
    );
    const res = await new IpfsQuorumService([gw], { quorum: 1 }).fetchValidated(
      { cid, binding },
    );
    expect(res.status).toBe('available');
    if (res.status === 'available') {
      expect(res.cid).toBe(cid);
      expect(res.cid).not.toContain('gateway');
    }
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('fails closed on invalid CID or incomplete binding', async () => {
    const svc = new IpfsQuorumService([provider('a', ok(good))], { quorum: 1 });
    const badCid = await svc.fetchValidated({ cid: 'not-a-cid', binding });
    expect(badCid.status === 'unavailable' && badCid.reason).toBe('invalid_cid');
    const badBinding = await svc.fetchValidated({
      cid,
      binding: { ...binding, artifactChecksum: '' },
    });
    expect(badBinding.status === 'unavailable' && badBinding.reason).toBe(
      'invalid_binding',
    );
  });
});

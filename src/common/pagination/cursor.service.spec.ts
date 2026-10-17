import {
  CursorService,
  CursorInvalidException,
  CursorBindingInput,
} from './cursor.service';

const release = {
  chainId: '10',
  releaseId: 'release-2025-01',
  deploymentBlock: 123456,
  artifactChecksum:
    '0000000000000000000000000000000000000000000000000000000000000000',
};

const baseBinding: CursorBindingInput = {
  route: 'claims:list',
  schemaVersion: 1,
  filters: { status: 'open', owner: '0xabc' },
  sort: 'createdAt:DESC,id:ASC',
  release,
};

function makeService(
  overrides: Partial<{
    now: () => number;
    previousKeys: { id: string; secret: string }[];
    ttlSeconds: number;
  }> = {},
) {
  const now = overrides.now ?? (() => 1700000000000);
  return new CursorService({
    activeKey: { id: 'k2025', secret: 'super-secret-active' },
    previousKeys: overrides.previousKeys ?? [],
    ttlSeconds: overrides.ttlSeconds ?? 60 * 60,
    now: now,
  });
}

describe('CursorService', () => {
  it('encodes and verifies a cursor for the same binding', () => {
    const svc = makeService();
    const cursor = svc.encode({ ...baseBinding, position: '123' });
    expect(typeof cursor).toBe('string');
    expect(cursor).not.toContain('123'); // opaque
    const result = svc.verify({ ...baseBinding, cursor });
    expect(result.position).toBe('123');
  });

  it('rejects tampered payload', () => {
    const svc = makeService();
    const cursor = svc.encode({ ...baseBinding, position: '123' });
    const [payload, sig] = cursor.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    decoded.pos = '999999';
    const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    expect(() =>
      svc.verify({ ...baseBinding, cursor: `${tampered}.${sig}` }),
    ).toThrow(CursorInvalidException);
  });

  it('rejects replay across endpoints', () => {
    const svc = makeService();
    const cursor = svc.encode({ ...baseBinding, position: '1' });
    expect(() =>
      svc.verify({
        ...baseBinding,
        route: 'claims:evidence',
        cursor,
      }),
    ).toThrow(CursorInvalidException);
  });

  it('rejects filter change', () => {
    const svc = makeService();
    const cursor = svc.encode({ ...baseBinding, position: '1' });
    expect(() =>
      svc.verify({
        ...baseBinding,
        filters: { status: 'closed', owner: '0xabc' },
        cursor,
      }),
    ).toThrow(CursorInvalidException);
  });

  it('rejects expired cursor', () => {
    let now = 1700000000000;
    const svc = makeService({ ttlSeconds: 1, now: () => now });
    const cursor = svc.encode({ ...baseBinding, position: '1' });
    now += 2 * 1000;
    expect(() => svc.verify({ ...baseBinding, cursor })).toThrow(
      CursorInvalidException,
    );
  });

  it('supports bounded key rotation', () => {
    const oldKey = { id: 'k2024', secret: 'super-secret-old' };
    const oldSvc = new CursorService({
      activeKey: oldKey,
      ttlSeconds: 60 * 60,
      now: () => 1700000000000,
    });
    const cursor = oldSvc.encode({ ...baseBinding, position: '42' });
    const newSvc = makeService({ previousKeys: [oldKey] });
    const result = newSvc.verify({ ...baseBinding, cursor });
    expect(result.position).toBe('42');
  });

  it('rejects cursor signed by key outside the bounded rotation set', () => {
    const oldKey = { id: 'k2023', secret: 'super-secret-old' };
    const oldSvc = new CursorService({
      activeKey: oldKey,
      ttlSeconds: 60 * 60,
      nowFns: () => 1700000000000,
    });
    const cursor = oldSvc.encode({ ...baseBinding, position: '42' });
    const newSvc = makeService();
    expect(() => newSvc.verify({ ...baseBinding, cursor })).toThrow(
      CursorInvalidException,
    );
  });

  it('rejects malformed base64', () => {
    const svc = makeService();
    expect(() =>
      svc.verify({ ...baseBinding, cursor: '===not-base64url===.' }),
    ).toThrow(CursorInvalidException);
  });

  it('rejects cursor with unsupported version', () => {
    const svc = makeService();
    const cursor = svc.encode({ ...baseBinding, position: '1' });
    const [payload, sig] = cursor.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    decoded.v = 999;
    const recoded = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    expect(() =>
      svc.verify({ ...baseBinding, cursor: `${recoded}.${sig}` }),
    ).toThrow(CursorInvalidException);
  });

  it('supports large offset positions', () => {
    const svc = makeService();
    const bigPosition = '9'.repeat(200);
    const cursor = svc.encode({ ...baseBinding, position: bigPosition });
    const result = svc.verify({ ...baseBinding, cursor });
    expect(result.position).toBe(bigPosition);
  });

  it('rejects cursor bound to a different release', () => {
    const svc = makeService();
    const cursor = svc.encode({ ...baseBinding, position: '1' });
    expect(() =>
      svc.verify({
        ...baseBinding,
        release: { ...release, releaseId: 'release-2025-02' },
        cursor,
      }),
    ).toThrow(CursorInvalidException);
  });

  it('does not leak signing material in errors', () => {
    const svc = makeService();
    try {
      svc.verify({ ...baseBinding, cursor: 'abc.def' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CursorInvalidException);
      const serialized = JSON.stringify((err as CursorInvalidException).getResponse());
      expect(serialized).not.toContain('super-secret');
      expect(serialized).not.toContain('key');
    }
  });
});

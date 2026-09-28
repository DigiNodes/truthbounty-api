import { assertValidExternalRequest, normalizeExternalRequest } from './external-request';

describe('external request normalization (issue #462)', () => {
  it('normalizes method/path and strips dangerous keys', () => {
    const n = normalizeExternalRequest({
      method: 'post',
      path: '/v2/claims',
      headers: { Authorization: 'Bearer x', __proto__: { polluted: true } as unknown as string },
      query: { limit: '10' },
      body: { ok: true, nested: { a: 'b' } },
    });
    expect(n.method).toBe('POST');
    expect(n.path).toBe('/v2/claims');
    expect(n.headers).toHaveProperty('authorization');
    expect(n.headers).not.toHaveProperty('__proto__');
  });

  it('fails closed on invalid path', () => {
    expect(() => assertValidExternalRequest({ method: 'GET', path: 'nope' })).toThrow(
      /INVALID_EXTERNAL_REQUEST_PATH/,
    );
  });
});

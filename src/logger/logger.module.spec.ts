import {
  serializeSafeRequest,
  serializeSafeResponse,
  serializeSafeError,
} from './logger.module';

describe('HTTP log serializers', () => {
  it('excludes URL, query, route parameters, and request identifiers', () => {
    const request = {
      method: 'GET',
      url: '/claims/private-id?token=secret',
      query: { token: 'secret' },
      params: { id: 'private-id' },
      id: 'caller-controlled-id',
    };
    const result = serializeSafeRequest(request);

    expect(result).toEqual({ method: 'GET' });
    expect(JSON.stringify(result)).not.toMatch(
      /private-id|secret|caller-controlled/i,
    );
  });

  it('logs a validated trace ID as the only request reference', () => {
    const traceId = 'a'.repeat(32);
    expect(
      serializeSafeResponse({
        statusCode: 200,
        getHeader: (name) => (name === 'x-trace-id' ? traceId : undefined),
      }),
    ).toEqual({ statusCode: 200, traceId });
    expect(
      serializeSafeResponse({
        statusCode: 200,
        getHeader: () => 'caller-provided-secret',
      }),
    ).toEqual({ statusCode: 200, traceId: undefined });
  });

  it('omits exception messages and stacks from serialized errors', () => {
    const error = {
      type: 'Error',
      message: 'authorization=secret-token',
      stack: 'private evidence and authorization=secret-token',
    };
    const result = serializeSafeError(error);

    expect(result).toEqual({ type: 'Error' });
    expect(JSON.stringify(result)).not.toMatch(
      /secret-token|private evidence/i,
    );
  });
});

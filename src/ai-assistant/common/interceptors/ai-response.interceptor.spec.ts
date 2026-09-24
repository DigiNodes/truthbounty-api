import { of } from 'rxjs';
import { AiResponseInterceptor } from './ai-response.interceptor';

describe('AiResponseInterceptor', () => {
  let interceptor: AiResponseInterceptor;

  const buildContext = (request: any) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
    }) as any;

  beforeEach(() => {
    interceptor = new AiResponseInterceptor();
  });

  it('wraps a plain return value as data with success:true', (done) => {
    const context = buildContext({ id: 'req-123' });
    const next = { handle: () => of({ foo: 'bar' }) };

    interceptor.intercept(context, next as any).subscribe((envelope) => {
      expect(envelope).toMatchObject({
        success: true,
        requestId: 'req-123',
        data: { foo: 'bar' },
        error: null,
      });
      expect(envelope.timestamp).toEqual(expect.any(String));
      done();
    });
  });

  it('generates a requestId when the request has none', (done) => {
    const context = buildContext({});
    const next = { handle: () => of({ ok: true }) };

    interceptor.intercept(context, next as any).subscribe((envelope) => {
      expect(envelope.requestId).toEqual(expect.any(String));
      expect(envelope.requestId.length).toBeGreaterThan(0);
      done();
    });
  });

  it('unwraps a { data, meta } handler return into envelope.data and envelope.meta', (done) => {
    const context = buildContext({ id: 'req-1' });
    const next = {
      handle: () => of({ data: { answer: 42 }, meta: { cached: true } }),
    };

    interceptor.intercept(context, next as any).subscribe((envelope) => {
      expect(envelope.data).toEqual({ answer: 42 });
      expect(envelope.meta).toEqual({ cached: true });
      done();
    });
  });

  it('treats null as an empty successful payload', (done) => {
    const context = buildContext({ id: 'req-1' });
    const next = { handle: () => of(null) };

    interceptor.intercept(context, next as any).subscribe((envelope) => {
      expect(envelope.data).toBeNull();
      expect(envelope.success).toBe(true);
      done();
    });
  });
});

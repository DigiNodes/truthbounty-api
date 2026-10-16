import { Span, SpanOptions } from '@opentelemetry/api';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisService } from './redis.service';
import { TracingService } from '../tracing/tracing.service';

describe('RedisService tracing privacy', () => {
  it('traces commands without including cache keys or values', async () => {
    const client = {
      get: jest.fn().mockResolvedValue('cached-secret'),
      set: jest.fn().mockResolvedValue('OK'),
      setex: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      ping: jest.fn().mockResolvedValue('PONG'),
    };
    const setAttribute = jest.fn();
    const span = {
      setAttribute,
      setStatus: jest.fn(),
    } as unknown as Span;
    const operations: string[] = [];
    const spanOptions: SpanOptions[] = [];
    const runSpan = jest.fn(
      (
        name: string,
        operation: (activeSpan: Span) => unknown,
        options?: SpanOptions,
      ) => {
        operations.push(name);
        if (options) spanOptions.push(options);
        return Promise.resolve(operation(span));
      },
    );
    const service = new RedisService(
      { get: jest.fn() } as unknown as ConfigService,
      { runSpan } as unknown as TracingService,
    );
    const internals = service as unknown as {
      client: Redis | null;
      isConnected: boolean;
    };
    internals.client = client as unknown as Redis;
    internals.isConnected = true;

    await service.get('sensitive:user:email');
    await service.set('sensitive:user:email', 'private-user-value', 60);
    await service.del('sensitive:user:email');
    await service.isHealthy();

    const spanCalls = JSON.stringify([operations, spanOptions]);
    expect(operations).toEqual([
      'redis.get',
      'redis.set',
      'redis.del',
      'redis.ping',
    ]);
    expect(spanCalls).not.toMatch(/sensitive:user:email|private-user-value/i);
    expect(spanOptions[0]).toMatchObject({
      attributes: {
        'db.system': 'redis',
        'db.operation.name': 'get',
      },
    });
  });

  it('records only the error type when a Redis operation fails', async () => {
    const setAttribute = jest.fn();
    const span = {
      setAttribute,
      setStatus: jest.fn(),
    } as unknown as Span;
    const runSpan = jest.fn(
      (
        _name: string,
        operation: (activeSpan: Span) => unknown,
        options?: SpanOptions,
      ) => {
        void options;
        return Promise.resolve(operation(span));
      },
    );
    const service = new RedisService(
      { get: jest.fn() } as unknown as ConfigService,
      { runSpan } as unknown as TracingService,
    );
    const internals = service as unknown as {
      client: Redis | null;
      isConnected: boolean;
    };
    internals.client = {
      get: jest.fn().mockRejectedValue(new Error('credential=private')),
    } as unknown as Redis;
    internals.isConnected = true;

    await expect(service.get('secret-key')).resolves.toBeNull();

    expect(setAttribute).toHaveBeenCalledWith('error.type', 'Error');
    expect(JSON.stringify(setAttribute.mock.calls)).not.toContain(
      'credential=private',
    );
  });
});

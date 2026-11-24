import { EventEmitter } from 'events';
import { Response } from 'express';
import { GracefulShutdownService } from './graceful-shutdown.service';

describe('GracefulShutdownService', () => {
  it('rejects new requests after drain starts and tracks admitted requests', async () => {
    const service = new GracefulShutdownService();
    const response = Object.assign(new EventEmitter(), {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }) as unknown as Response;
    const next = jest.fn();

    service.middleware({} as never, response, next);
    expect(next).toHaveBeenCalledTimes(1);

    const closing = service.shutdown(async () => undefined);
    const rejectedResponse = Object.assign(new EventEmitter(), {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }) as unknown as Response;
    service.middleware({} as never, rejectedResponse, next);

    expect(rejectedResponse.status).toHaveBeenCalledWith(503);
    expect(rejectedResponse.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    expect(next).toHaveBeenCalledTimes(1);

    response.emit('finish');
    await expect(closing).resolves.toEqual({ timedOut: false, failed: false });
  });

  it('waits for admitted operations and rejects work after drain begins', async () => {
    const service = new GracefulShutdownService();
    let finish!: () => void;
    const operation = service.runTracked(
      'active-worker',
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const closeApplication = jest.fn().mockResolvedValue(undefined);
    const closing = service.shutdown(closeApplication, 1_000);

    await expect(
      service.runTracked('new-worker', async () => undefined),
    ).rejects.toThrow('application is draining');
    expect(closeApplication).not.toHaveBeenCalled();

    finish();
    await operation;
    await expect(closing).resolves.toEqual({ timedOut: false, failed: false });
    expect(closeApplication).toHaveBeenCalledTimes(1);
  });

  it('bounds shutdown when a worker is stuck and still attempts resource closure', async () => {
    const service = new GracefulShutdownService();
    const closeApplication = jest.fn().mockResolvedValue(undefined);
    service.registerStopHook('stuck-worker', () => new Promise<void>(() => {}));

    const startedAt = Date.now();
    const result = await service.shutdown(closeApplication, 20);

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.timedOut).toBe(true);
    expect(closeApplication).toHaveBeenCalledTimes(1);
  });

  it('runs shutdown only once when signals are repeated', async () => {
    const service = new GracefulShutdownService();
    const stop = jest.fn();
    const closeApplication = jest.fn().mockResolvedValue(undefined);
    service.registerStopHook('consumer', stop);

    const first = service.shutdown(closeApplication);
    const second = service.shutdown(closeApplication);

    expect(second).toBe(first);
    await first;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(closeApplication).toHaveBeenCalledTimes(1);
  });

  it('stops registered cron jobs, intervals, and timeouts', async () => {
    const service = new GracefulShutdownService();
    const cronStop = jest.fn();
    const deleteInterval = jest.fn();
    const deleteTimeout = jest.fn();
    service.setSchedulerRegistry({
      getCronJobs: () => new Map([['cron', { stop: cronStop }]]),
      getIntervals: () => ['interval'],
      deleteInterval,
      getTimeouts: () => ['timeout'],
      deleteTimeout,
    } as never);

    await service.shutdown(async () => undefined);

    expect(cronStop).toHaveBeenCalledTimes(1);
    expect(deleteInterval).toHaveBeenCalledWith('interval');
    expect(deleteTimeout).toHaveBeenCalledWith('timeout');
  });

  it('reports cleanup failures but continues closing resources', async () => {
    const service = new GracefulShutdownService();
    const closeApplication = jest.fn().mockResolvedValue(undefined);
    service.registerStopHook('failed-consumer', () => {
      throw new Error('stop failed');
    });

    await expect(service.shutdown(closeApplication)).resolves.toEqual({
      timedOut: false,
      failed: true,
    });
    expect(closeApplication).toHaveBeenCalledTimes(1);
  });
});

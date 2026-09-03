import { HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, Observable, of, throwError } from 'rxjs';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RealtimeStreamController } from './realtime-stream.controller';
import { RealtimeService, RealtimeBackpressureError } from './realtime.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProjectionEventType, RealtimeEnvelopeType } from './realtime.enums';

describe('RealtimeStreamController', () => {
  let controller: RealtimeStreamController;
  let realtime: { streamFrom: jest.Mock; emitWithinTransaction: jest.Mock };
  let configService: { getConfig: jest.Mock };
  let dataSource: any;

  const config = {
    pollIntervalMs: 1000,
    maxPublishBatch: 100,
    heartbeatIntervalMs: 15000,
    maxBacklog: 5,
    maxReplayRows: 100,
  };

  beforeEach(() => {
    realtime = {
      streamFrom: jest.fn(),
      emitWithinTransaction: jest.fn(),
    };
    configService = { getConfig: jest.fn().mockReturnValue(config) };
    dataSource = {};

    controller = new (RealtimeStreamController as any)(
      realtime as any,
      configService as any,
      dataSource,
    );
  });

  function makeEnvelope(over: any) {
    return {
      cursor: 1,
      type: RealtimeEnvelopeType.EVENT,
      sourceCursor: 1,
      aggregateType: 'claim',
      aggregateId: 'c1',
      data: { a: 1 },
      timestamp: new Date().toISOString(),
      ...over,
    };
  }

  describe('stream', () => {
    function collect<T>(obs: Observable<T>): Promise<T[]> {
      return new Promise<T[]>((resolve, reject) => {
        const out: T[] = [];
        obs.subscribe({
          next: (v) => out.push(v),
          error: reject,
          complete: () => resolve(out),
        });
      });
    }

    it('maps event envelopes to SSE messages and does not advance heartbeat data', async () => {
      realtime.streamFrom.mockReturnValue(
        of(
          makeEnvelope({}),
          makeEnvelope({
            type: RealtimeEnvelopeType.HEARTBEAT,
            heartbeat: true,
          }),
        ),
      );

      const messages = await collect(controller.stream({ headers: {} } as any));

      expect(realtime.streamFrom).toHaveBeenCalledWith({
        afterId: 0,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        maxBacklog: config.maxBacklog,
      });
      expect(messages[0]).toMatchObject({ type: RealtimeEnvelopeType.EVENT });
      expect(messages[1]).toMatchObject({
        type: RealtimeEnvelopeType.HEARTBEAT,
        data: {},
      });
    });

    it('parses Last-Event-ID as resume cursor', async () => {
      realtime.streamFrom.mockReturnValue(of(makeEnvelope({})));

      await lastValueFrom(
        controller.stream({ headers: { 'last-event-id': '41' } } as any),
      );

      expect(realtime.streamFrom).toHaveBeenCalledWith(
        expect.objectContaining({ afterId: 41 }),
      );
    });

    it('treats an invalid Last-Event-ID as cursor zero (fail closed)', async () => {
      realtime.streamFrom.mockReturnValue(of(makeEnvelope({})));

      await lastValueFrom(
        controller.stream({
          headers: { 'last-event-id': 'not-a-number' },
        } as any),
      );

      expect(realtime.streamFrom).toHaveBeenCalledWith(
        expect.objectContaining({ afterId: 0 }),
      );
    });

    it('translates backpressure errors into 503 SERVICE_UNAVAILABLE', async () => {
      realtime.streamFrom.mockReturnValue(
        throwError(
          () =>
            new RealtimeBackpressureError('backlog exceeded bounded capacity'),
        ),
      );

      let caught: unknown;
      await new Promise<void>((resolve) => {
        controller.stream({ headers: {} } as any).subscribe({
          error: (e) => {
            caught = e;
            resolve();
          },
        });
      });

      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    });
  });

  describe('authorization', () => {
    it('registers JwtAuthGuard on the controller so the stream is authenticated', () => {
      const reflector = new Reflector();
      const guards =
        reflector.get<any[]>(GUARDS_METADATA, RealtimeStreamController) ?? [];
      expect(guards.some((guard) => guard === JwtAuthGuard)).toBe(true);
    });
  });

  describe('publish', () => {
    it('records a projection change within a committed transaction', async () => {
      const queryRunner = {
        connect: jest.fn(async () => undefined),
        startTransaction: jest.fn(async () => undefined),
        commitTransaction: jest.fn(async () => undefined),
        rollbackTransaction: jest.fn(async () => undefined),
        release: jest.fn(async () => undefined),
        manager: { sentinel: true },
      };
      dataSource.createQueryRunner = jest.fn().mockReturnValue(queryRunner);
      realtime.emitWithinTransaction.mockResolvedValue({ id: 77 });

      const dto = {
        aggregateType: 'claim',
        aggregateId: 'c1',
        eventType: ProjectionEventType.CREATED,
        payload: { status: 'open' },
      };

      const result = await controller.publish(dto as any);

      expect(realtime.emitWithinTransaction).toHaveBeenCalledWith(
        queryRunner.manager,
        dto,
      );
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(result).toEqual({ accepted: true, cursor: 77 });
    });

    it('rolls back and surfaces a 400 on validation failure', async () => {
      const queryRunner = {
        connect: jest.fn(async () => undefined),
        startTransaction: jest.fn(async () => undefined),
        commitTransaction: jest.fn(async () => undefined),
        rollbackTransaction: jest.fn(async () => undefined),
        release: jest.fn(async () => undefined),
        manager: {},
      };
      dataSource.createQueryRunner = jest.fn().mockReturnValue(queryRunner);
      realtime.emitWithinTransaction.mockRejectedValue(
        new Error('Invalid aggregateType'),
      );

      await expect(controller.publish({} as any)).rejects.toThrow(
        HttpException,
      );
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });
  });
});

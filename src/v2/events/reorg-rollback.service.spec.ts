import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ModuleRef } from '@nestjs/core';
import { BadRequestException } from '@nestjs/common';
import { ReorgRollbackService } from './reorg-rollback.service';
import { CanonicalEventsService } from './canonical-events.service';
import { RawLog } from './interfaces/canonical-event.interface';
import { IV2Projector } from './interfaces/reorg-rollback.interface';

describe('ReorgRollbackService (unit)', () => {
  let service: ReorgRollbackService;
  let dataSource: jest.Mocked<Partial<DataSource>>;
  let canonicalEventsService: jest.Mocked<Partial<CanonicalEventsService>>;
  let moduleRef: jest.Mocked<Partial<ModuleRef>>;

  beforeEach(async () => {
    dataSource = {
      transaction: jest.fn(),
    };
    canonicalEventsService = {
      ingest: jest.fn(),
    };
    moduleRef = {
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReorgRollbackService,
        { provide: DataSource, useValue: dataSource },
        { provide: CanonicalEventsService, useValue: canonicalEventsService },
        { provide: ModuleRef, useValue: moduleRef },
      ],
    }).compile();

    service = module.get<ReorgRollbackService>(ReorgRollbackService);
  });

  describe('validation (fail-closed)', () => {
    it('throws BadRequestException for invalid or negative chainId', async () => {
      await expect(service.rollback(0, 100n)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.rollback(-1, 100n)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.rollback(1.5, 100n)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException for negative rollbackToBlock', async () => {
      await expect(service.rollback(10, -1n)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.rollback(10, '-5')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException for non-numeric rollbackToBlock', async () => {
      await expect(service.rollback(10, 'invalid')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('reapplyLogs', () => {
    it('sorts logs deterministically by blockNumber ASC, logIndex ASC before ingesting', async () => {
      const mockProjector: IV2Projector = {
        processNewEvents: jest
          .fn()
          .mockResolvedValueOnce({ processed: 2, applied: 2 }),
      };
      service.registerProjector('mock-projector', mockProjector);

      (canonicalEventsService.ingest as jest.Mock).mockResolvedValue({
        status: 'ingested',
      });

      const logs: RawLog[] = [
        {
          chainId: 10,
          address: '0x1111111111111111111111111111111111111111',
          topics: [],
          data: '0x',
          transactionHash: '0xtx2',
          logIndex: 1,
          blockNumber: 200n,
        },
        {
          chainId: 10,
          address: '0x1111111111111111111111111111111111111111',
          topics: [],
          data: '0x',
          transactionHash: '0xtx1',
          logIndex: 0,
          blockNumber: 100n,
        },
        {
          chainId: 10,
          address: '0x1111111111111111111111111111111111111111',
          topics: [],
          data: '0x',
          transactionHash: '0xtx3',
          logIndex: 0,
          blockNumber: 200n,
        },
      ];

      const result = await service.reapplyLogs(logs);

      expect(canonicalEventsService.ingest).toHaveBeenCalledTimes(3);
      // Ensure ingestion order is block 100 log 0, block 200 log 0, block 200 log 1
      expect(
        (canonicalEventsService.ingest as jest.Mock).mock.calls[0][0]
          .blockNumber,
      ).toBe(100n);
      expect(
        (canonicalEventsService.ingest as jest.Mock).mock.calls[1][0]
          .transactionHash,
      ).toBe('0xtx3');
      expect(
        (canonicalEventsService.ingest as jest.Mock).mock.calls[2][0]
          .transactionHash,
      ).toBe('0xtx2');

      expect(result.logsProcessed).toBe(3);
      expect(result.ingestedCount).toBe(3);
      expect(result.projectorSummaries['mock-projector'].applied).toBe(2);
    });

    it('handles empty logs array cleanly by only draining projectors', async () => {
      const mockProjector: IV2Projector = {
        processNewEvents: jest
          .fn()
          .mockResolvedValueOnce({ processed: 0, applied: 0 }),
      };
      service.registerProjector('mock-projector', mockProjector);

      const result = await service.reapplyLogs([]);
      expect(result.logsProcessed).toBe(0);
      expect(canonicalEventsService.ingest).not.toHaveBeenCalled();
      expect(mockProjector.processNewEvents).toHaveBeenCalled();
    });
  });

  describe('reapplyProjectors', () => {
    it('drains projectors in batches until no new events remain', async () => {
      const mockProjector: IV2Projector = {
        processNewEvents: jest
          .fn()
          .mockResolvedValueOnce({
            processed: 10,
            applied: 10,
            anomalies: 0,
            duplicates: 0,
          })
          .mockResolvedValueOnce({
            processed: 5,
            applied: 5,
            anomalies: 1,
            duplicates: 0,
          }),
      };
      service.registerProjector('batch-projector', mockProjector);

      const summaries = await service.reapplyProjectors(10);
      expect(summaries['batch-projector']).toEqual({
        processed: 15,
        applied: 15,
        anomalies: 1,
        duplicates: 0,
      });
      expect(mockProjector.processNewEvents).toHaveBeenCalledTimes(2);
    });
  });
});

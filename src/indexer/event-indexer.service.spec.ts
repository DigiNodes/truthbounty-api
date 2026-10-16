import { Test, TestingModule } from '@nestjs/testing';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventIndexerService } from './event-indexer.service';
import { IndexedEvent, IndexingState } from '../entities';
import { EventIndexerConfig } from '../config';
import { SpanKind } from '@opentelemetry/api';

describe('EventIndexerService', () => {
  let service: EventIndexerService;
  let eventRepository: Repository<IndexedEvent>;
  let stateRepository: Repository<IndexingState>;
  let mockConfig: EventIndexerConfig;

  beforeEach(async () => {
    mockConfig = {
      rpcUrl: 'https://mainnet.optimism.io',
      chainId: 10,
      confirmationsRequired: 12,
      blockRangePerBatch: 5000,
      maxRetryAttempts: 3,
      pollingIntervalMs: 12000,
      contracts: [],
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: EventIndexerService,
          useValue: new EventIndexerService(
            mockConfig,
            {} as Repository<IndexedEvent>,
            {} as Repository<IndexingState>,
          ),
        },
      ],
    }).compile();

    service = module.get<EventIndexerService>(EventIndexerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getStatus', () => {
    it('should return indexer status', async () => {
      const status = await service.getStatus();
      expect(status).toBeDefined();
      expect(status.isRunning).toBeDefined();
      expect(status.currentBlockNumber).toBeDefined();
      expect(Array.isArray(status.indexingStates)).toBe(true);
    });
  });

  describe('backfillFromBlock', () => {
    it('should throw error if contract not found', async () => {
      await expect(
        service.backfillFromBlock('0x0000000000000000000000000000000000000000', 1000),
      ).rejects.toThrow();
    });
  });

  it('creates a safe child span around indexed event batches', async () => {
    const tracingService = {
      runSpan: jest.fn(async (_name, operation, _options) => operation()),
    };
    const stateRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    const tracedService = new EventIndexerService(
      mockConfig,
      {} as Repository<IndexedEvent>,
      stateRepository as unknown as Repository<IndexingState>,
      tracingService as unknown as any,
    );

    await (tracedService as any).indexEventType(
      '0x0000000000000000000000000000000000000001',
      { name: 'Event' },
      100,
    );

    expect(tracingService.runSpan).toHaveBeenCalledWith(
      'indexer.event_batch',
      expect.any(Function),
      expect.objectContaining({ kind: SpanKind.INTERNAL }),
    );
  });
});

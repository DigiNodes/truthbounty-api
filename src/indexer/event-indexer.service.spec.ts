import { Test, TestingModule } from '@nestjs/testing';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventIndexerService } from './event-indexer.service';
import { IndexedEvent, IndexingState } from '../entities';
import { EventIndexerConfig } from '../config';

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
});

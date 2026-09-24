import { Test, TestingModule } from '@nestjs/testing';
import { ethers, EventLog } from 'ethers';
import { EventIndexerService } from './event-indexer.service';
import { EventIndexerConfig } from '../config';

describe('EventIndexerService', () => {
  let service: EventIndexerService;
  let eventRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
  };
  let stateRepository: {
    findOne: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
  };
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

    eventRepository = {
      findOne: jest.fn(),
      create: jest.fn((event) => event),
      save: jest.fn(),
      find: jest.fn(),
    };
    stateRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: EventIndexerService,
          useValue: new EventIndexerService(
            mockConfig,
            eventRepository as any,
            stateRepository as any,
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
      stateRepository.findOne.mockResolvedValue(null);

      await expect(
        service.backfillFromBlock(
          '0x0000000000000000000000000000000000000000',
          1000,
        ),
      ).rejects.toThrow();
    });
  });

  describe('processEvent', () => {
    it('serializes decoded BigInt event args as decimal strings before persistence', async () => {
      const iface = new ethers.Interface([
        'event Transfer(address indexed from, address indexed to, uint256 amount)',
      ]);
      const encoded = iface.encodeEventLog(iface.getEvent('Transfer')!, [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        9007199254740993n,
      ]);
      const log = {
        transactionHash: '0x' + 'a'.repeat(64),
        blockNumber: 100,
        index: 2,
        topics: encoded.topics,
        data: encoded.data,
      } as unknown as EventLog;

      eventRepository.findOne.mockResolvedValue(null);
      (service as any).provider = {
        getBlock: jest.fn().mockResolvedValue({ number: 100 }),
      };

      await (service as any).processEvent(
        '0x0000000000000000000000000000000000000003',
        {
          name: 'Transfer',
          abi: 'event Transfer(address indexed from, address indexed to, uint256 amount)',
        },
        log,
        120,
      );

      const persistedEvent = eventRepository.create.mock.calls[0][0];

      expect(persistedEvent.parsedData).toMatchObject({
        from: '0x0000000000000000000000000000000000000001',
        to: '0x0000000000000000000000000000000000000002',
        amount: '9007199254740993',
      });
      expect(() => JSON.stringify(persistedEvent.parsedData)).not.toThrow();
      expect(eventRepository.save).toHaveBeenCalledWith(persistedEvent);
    });
  });
});

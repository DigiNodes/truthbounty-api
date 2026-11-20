import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Interface, AbiCoder } from 'ethers';
import { CanonicalEventsService } from './canonical-events.service';
import { EventQuarantineService } from './event-quarantine.service';
import { ArtifactRegistryService } from './artifact-registry.service';
import { EventDecoderService } from './event-decoder.service';
import { CanonicalEvent } from './entities/canonical-event.entity';
import { ContractArtifact } from './entities/contract-artifact.entity';
import {
  EventQuarantine,
  QuarantineReason,
} from './entities/event-quarantine.entity';
import { EventCheckpoint } from './entities/event-checkpoint.entity';
import { RawLog } from './interfaces/canonical-event.interface';
import { CANONICAL_CHAIN_HEADS, CanonicalChainHeads } from './chain-heads';
import { IndexerConfigService } from '../../config/indexer-config.service';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'crypto';

/**
 * Exercises CanonicalEventsService against a real (sqlite, in-memory)
 * database, so unique-constraint driven idempotency and the same-transaction
 * checkpoint advance are verified against actual DB behavior rather than
 * mocked repositories.
 */
describe('CanonicalEventsService (integration)', () => {
  let moduleRef: TestingModule;
  let service: CanonicalEventsService;
  let dataSource: DataSource;
  let artifactRepo: Repository<ContractArtifact>;
  let quarantineRepo: Repository<EventQuarantine>;
  let checkpointRepo: Repository<EventCheckpoint>;
  let providerHeads: CanonicalChainHeads;
  let headsAvailable: boolean;
  let observedAt: Date;

  const abi = [
    'event EvidenceRegistered(bytes32 indexed claimId, address indexed submitter, bytes32 digest)',
  ];
  const iface = new Interface(abi);
  const contractAddress = '0x' + 'aa'.repeat(20);

  function makeLog(overrides: Partial<RawLog> = {}): RawLog {
    const claimId = '0x' + '11'.repeat(32);
    const submitter = '0x' + '22'.repeat(20);
    const fragment = iface.getEvent('EvidenceRegistered')!;
    const topics = iface.encodeFilterTopics(fragment, [
      claimId,
      submitter,
    ]) as string[];
    const data = AbiCoder.defaultAbiCoder().encode(
      ['bytes32'],
      ['0x' + '33'.repeat(32)],
    );
    return {
      chainId: 10,
      address: contractAddress,
      topics,
      data,
      transactionHash: '0x' + '44'.repeat(32),
      logIndex: 0,
      blockNumber: 500n,
      ...overrides,
    };
  }

  beforeEach(async () => {
    observedAt = new Date();
    headsAvailable = true;
    providerHeads = {
      chainId: 10,
      observedHead: 520n,
      safeHead: 500n,
      finalizedHead: 480n,
      safeBlockHash: '0x' + '66'.repeat(32),
      finalizedBlockHash: '0x' + '77'.repeat(32),
      observedAt,
      source: 'provider:eth_getBlockByNumber(latest|safe|finalized)',
    };
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          driver: require('better-sqlite3'),
          entities: [
            CanonicalEvent,
            ContractArtifact,
            EventQuarantine,
            EventCheckpoint,
          ],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([
          CanonicalEvent,
          ContractArtifact,
          EventQuarantine,
          EventCheckpoint,
        ]),
      ],
      providers: [
        CanonicalEventsService,
        ArtifactRegistryService,
        EventDecoderService,
        EventQuarantineService,
        {
          provide: IndexerConfigService,
          useValue: {
            getEventIndexerConfig: () => ({ rpcUrl: '', chainId: 10 }),
          },
        },
        {
          provide: CANONICAL_CHAIN_HEADS,
          useValue: {
            getHeads: async (chainId: number) =>
              headsAvailable && chainId === 10 ? providerHeads : null,
          },
        },
      ],
    }).compile();

    service = moduleRef.get(CanonicalEventsService);
    dataSource = moduleRef.get(DataSource);
    artifactRepo = dataSource.getRepository(ContractArtifact);
    quarantineRepo = dataSource.getRepository(EventQuarantine);
    checkpointRepo = dataSource.getRepository(EventCheckpoint);

    await artifactRepo.insert({
      chainId: 10,
      contractAddress,
      artifactVersion: 'v1',
      abiChecksum: crypto
        .createHash('sha256')
        .update(JSON.stringify(abi))
        .digest('hex'),
      abi,
      isApproved: true,
    });
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('ingests a valid log, persists it, and advances the checkpoint in the same operation', async () => {
    const outcome = await service.ingest(makeLog());
    expect(outcome.status).toBe('ingested');

    const stored = await dataSource.getRepository(CanonicalEvent).find();
    expect(stored).toHaveLength(1);
    expect(stored[0].eventName).toBe('EvidenceRegistered');

    const checkpoint = await checkpointRepo.findOne({
      where: { chainId: 10, contractAddress },
    });
    expect(String(checkpoint?.lastSafeBlock)).toBe('500');
  });

  it('is idempotent: replaying the identical log is reported as a duplicate, not a second row', async () => {
    const log = makeLog();
    await service.ingest(log);
    const second = await service.ingest(log);

    expect(second.status).toBe('duplicate');
    const stored = await dataSource.getRepository(CanonicalEvent).find();
    expect(stored).toHaveLength(1);
  });

  it('never advances the checkpoint backward for an out-of-order lower block', async () => {
    await service.ingest(
      makeLog({
        blockNumber: 500n,
        logIndex: 0,
        transactionHash: '0x' + '44'.repeat(32),
      }),
    );
    await service.ingest(
      makeLog({
        blockNumber: 400n,
        logIndex: 0,
        transactionHash: '0x' + '55'.repeat(32),
      }),
    );

    const checkpoint = await checkpointRepo.findOne({
      where: { chainId: 10, contractAddress },
    });
    expect(String(checkpoint?.lastSafeBlock)).toBe('500');
  });

  it('quarantines logs from an unregistered contract address (fails closed)', async () => {
    const outcome = await service.ingest(
      makeLog({ address: '0x' + 'bb'.repeat(20) }),
    );
    expect(outcome).toEqual({
      status: 'quarantined',
      reason: QuarantineReason.UNREGISTERED_ADDRESS,
    });

    const quarantined = await quarantineRepo.find();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].reason).toBe(QuarantineReason.UNREGISTERED_ADDRESS);
  });

  it('quarantines an unknown signature rather than throwing', async () => {
    const outcome = await service.ingest(
      makeLog({ topics: ['0x' + 'ff'.repeat(32)], data: '0x' }),
    );
    expect(outcome).toEqual({
      status: 'quarantined',
      reason: QuarantineReason.UNKNOWN_SIGNATURE,
    });
  });

  it('replaying an already-quarantined log does not throw or duplicate the quarantine row', async () => {
    const log = makeLog({ address: '0x' + 'bb'.repeat(20) });
    await service.ingest(log);
    await service.ingest(log);

    const quarantined = await quarantineRepo.find();
    expect(quarantined).toHaveLength(1);
  });

  describe('finality derived from provider chain heads', () => {
    async function checkpoint() {
      return checkpointRepo.findOne({
        where: { chainId: 10, contractAddress },
      });
    }

    it('keeps both watermarks behind the log when provider heads are behind it', async () => {
      providerHeads = {
        ...providerHeads,
        observedHead: 120n,
        safeHead: 100n,
        finalizedHead: 50n,
      };

      await service.ingest(makeLog({ blockNumber: 500n }));

      const cp = await checkpoint();
      expect(String(cp?.lastProcessedBlock)).toBe('500');
      expect(String(cp?.lastSafeBlock)).toBe('100');
      expect(String(cp?.lastFinalizedBlock)).toBe('50');
    });

    it('advances finality from heads during backfill instead of the log block', async () => {
      providerHeads = {
        ...providerHeads,
        observedHead: 1100n,
        safeHead: 1000n,
        finalizedHead: 900n,
      };

      await service.ingest(
        makeLog({ blockNumber: 100n, transactionHash: '0x' + '88'.repeat(32) }),
      );

      const cp = await checkpoint();
      expect(String(cp?.lastProcessedBlock)).toBe('100');
      expect(String(cp?.lastSafeBlock)).toBe('1000');
      expect(String(cp?.lastFinalizedBlock)).toBe('900');
    });

    it('records head provenance and observation time alongside the watermarks', async () => {
      await service.ingest(makeLog());

      const cp = await checkpoint();
      expect(cp?.headSource).toBe(providerHeads.source);
      expect(cp?.headsObservedAt).not.toBeNull();
      expect(String(cp?.observedHead)).toBe('520');
      expect(cp?.lastSafeBlockHash).toBe(providerHeads.safeBlockHash);
      expect(cp?.lastFinalizedBlockHash).toBe(providerHeads.finalizedBlockHash);
    });

    it.each([
      ['missing', 'missing'],
      ['wrong chain', { ...providerHeads, chainId: 137 }],
      [
        'stale',
        { ...providerHeads, observedAt: new Date(Date.now() - 20 * 60_000) },
      ],
      [
        'contradictory ordering',
        { ...providerHeads, safeHead: 40n, finalizedHead: 50n },
      ],
      [
        'safe above observed',
        { ...providerHeads, observedHead: 100n, safeHead: 500n },
      ],
      ['malformed hash', { ...providerHeads, safeBlockHash: '0xdeadbeef' }],
      ['negative head', { ...providerHeads, finalizedHead: -1n }],
    ])('fails closed on %s heads', async (label, heads) => {
      if (label === 'missing') {
        headsAvailable = false;
      } else {
        providerHeads = heads as CanonicalChainHeads;
      }

      await service.ingest(makeLog());

      const cp = await checkpoint();
      expect(String(cp?.lastProcessedBlock)).toBe('500');
      expect(String(cp?.lastSafeBlock)).toBe('0');
      expect(String(cp?.lastFinalizedBlock)).toBe('0');
      expect(cp?.headSource).toBeNull();
      expect(cp?.headsObservedAt).toBeNull();
    });

    it('does not advertise a reorged height as safe or finalized', async () => {
      await service.ingest(makeLog());
      expect(String((await checkpoint())?.lastSafeBlock)).toBe('500');

      // Provider heads regress after a reorg of an unfinalized block.
      providerHeads = {
        ...providerHeads,
        observedHead: 430n,
        safeHead: 450n,
        finalizedHead: 430n,
      };
      await service.ingest(
        makeLog({ blockNumber: 520n, transactionHash: '0x' + '99'.repeat(32) }),
      );

      const cp = await checkpoint();
      expect(String(cp?.lastSafeBlock)).toBe('500');
      expect(String(cp?.lastFinalizedBlock)).toBe('480');
      expect(String(cp?.lastProcessedBlock)).toBe('520');
    });

    it('never regresses watermarks for out-of-order or concurrent ingests', async () => {
      providerHeads = {
        ...providerHeads,
        observedHead: 700n,
        safeHead: 700n,
        finalizedHead: 650n,
      };
      const blocks = [600n, 200n, 400n, 100n, 500n];
      for (const [index, blockNumber] of blocks.entries()) {
        await service.ingest(
          makeLog({
            blockNumber,
            logIndex: index,
            transactionHash:
              '0x' + (index + 1).toString(16).padStart(2, '0').repeat(32),
          }),
        );
      }

      const cp = await checkpoint();
      expect(String(cp?.lastSafeBlock)).toBe('700');
      expect(String(cp?.lastFinalizedBlock)).toBe('650');
      expect(String(cp?.lastProcessedBlock)).toBe('600');
    });
  });
});

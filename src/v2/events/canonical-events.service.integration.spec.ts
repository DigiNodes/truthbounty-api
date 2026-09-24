import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Interface, AbiCoder } from 'ethers';
import { CanonicalEventsService } from './canonical-events.service';
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
import { DataSource, Repository } from 'typeorm';

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
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          driver: require('sqlite3'),
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
});

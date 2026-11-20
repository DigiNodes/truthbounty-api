import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Interface, AbiCoder } from 'ethers';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CanonicalEventsService } from './canonical-events.service';
import { ArtifactRegistryService } from './artifact-registry.service';
import { EventDecoderService } from './event-decoder.service';
import { EventQuarantineService } from './event-quarantine.service';
import { CanonicalEvent } from './entities/canonical-event.entity';
import { ContractArtifact } from './entities/contract-artifact.entity';
import { EventCheckpoint } from './entities/event-checkpoint.entity';
import { EventQuarantine } from './entities/event-quarantine.entity';
import { RawLog } from './interfaces/canonical-event.interface';
import { CANONICAL_CHAIN_HEADS, CanonicalChainHeads } from './chain-heads';
import { IndexerConfigService } from '../../config/indexer-config.service';

/**
 * PostgreSQL acceptance test for checkpoint persistence. It is skipped unless
 * CHECKPOINT_TEST_DATABASE_URL is provided so the default suite stays hermetic.
 * Run with a throwaway Postgres database, e.g.:
 *   CHECKPOINT_TEST_DATABASE_URL=postgres://... npx jest canonical-events.postgres
 */
const url = process.env.CHECKPOINT_TEST_DATABASE_URL;
(url ? describe : describe.skip)('CanonicalEventsCheckpoint (postgres)', () => {
  const schema = `checkpoint_test_${randomUUID().replace(/-/g, '')}`;
  const contractAddress = '0x' + 'aa'.repeat(20);
  const abi = [
    'event EvidenceRegistered(bytes32 indexed claimId, address indexed submitter, bytes32 digest)',
  ];
  const iface = new Interface(abi);
  let heads: CanonicalChainHeads = {
    chainId: 10,
    observedHead: 900n,
    safeHead: 850n,
    finalizedHead: 800n,
    observedAt: new Date(),
    source: 'provider:eth_getBlockByNumber(latest|safe|finalized)',
  };

  function makeLog(blockNumber: bigint, salt = '44'): RawLog {
    const fragment = iface.getEvent('EvidenceRegistered')!;
    return {
      chainId: 10,
      address: contractAddress,
      topics: iface.encodeFilterTopics(fragment, [
        '0x' + '11'.repeat(32),
        '0x' + '22'.repeat(20),
      ]) as string[],
      data: AbiCoder.defaultAbiCoder().encode(
        ['bytes32'],
        ['0x' + '33'.repeat(32)],
      ),
      transactionHash: '0x' + salt.repeat(32),
      logIndex: 0,
      blockNumber,
    };
  }

  const dbOptions = () => ({
    type: 'postgres' as const,
    url,
    schema,
    entities: [
      CanonicalEvent,
      ContractArtifact,
      EventQuarantine,
      EventCheckpoint,
    ],
    synchronize: true,
  });

  async function buildModule(): Promise<TestingModule> {
    return Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOptions()),
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
          useValue: { getHeads: async () => heads },
        },
      ],
    }).compile();
  }

  afterAll(async () => {
    if (!url) return;
    const dataSource = new DataSource(dbOptions());
    await dataSource.initialize();
    await dataSource.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await dataSource.destroy();
  });

  it('persists progress and provider heads transactionally and across restarts', async () => {
    let moduleRef = await buildModule();
    let dataSource = moduleRef.get(DataSource);
    const artifacts = dataSource.getRepository(ContractArtifact);
    await artifacts.upsert(
      {
        chainId: 10,
        contractAddress,
        artifactVersion: 'v1',
        abiChecksum: '0x' + 'ab'.repeat(32),
        abi,
        isApproved: true,
      },
      { conflictPaths: ['chainId', 'contractAddress'] },
    );

    const service = moduleRef.get(CanonicalEventsService);
    const outcome = await service.ingest(makeLog(100n));
    expect(outcome.status).toBe('ingested');

    const cp = await dataSource.getRepository(EventCheckpoint).findOne({
      where: { chainId: 10, contractAddress },
    });
    expect(String(cp?.lastProcessedBlock)).toBe('100');
    expect(String(cp?.lastSafeBlock)).toBe('850');
    expect(String(cp?.lastFinalizedBlock)).toBe('800');
    expect(cp?.headSource).toBe(heads.source);
    await moduleRef.close();

    // Restart: a fresh connection/module must read the same committed facts.
    moduleRef = await buildModule();
    dataSource = moduleRef.get(DataSource);
    const restored = await dataSource.getRepository(EventCheckpoint).findOne({
      where: { chainId: 10, contractAddress },
    });
    expect(String(restored?.lastSafeBlock)).toBe('850');
    expect(String(restored?.lastFinalizedBlock)).toBe('800');
    expect(String(restored?.lastProcessedBlock)).toBe('100');
    await moduleRef.close();
  });

  it('fails closed on an invalid head observation', async () => {
    const moduleRef = await buildModule();
    const dataSource = moduleRef.get(DataSource);
    await dataSource.getRepository(ContractArtifact).upsert(
      {
        chainId: 10,
        contractAddress,
        artifactVersion: 'v1',
        abiChecksum: '0x' + 'ab'.repeat(32),
        abi,
        isApproved: true,
      },
      { conflictPaths: ['chainId', 'contractAddress'] },
    );
    const service = moduleRef.get(CanonicalEventsService);
    heads = { ...heads, safeHead: 10n, finalizedHead: 20n };

    const outcome = await service.ingest(makeLog(100n, '66'));
    expect(outcome.status).toBe('ingested');
    const cp = await dataSource.getRepository(EventCheckpoint).findOne({
      where: { chainId: 10, contractAddress },
    });
    expect(String(cp?.lastSafeBlock)).toBe('0');
    expect(String(cp?.lastFinalizedBlock)).toBe('0');
    await moduleRef.close();
  });
});

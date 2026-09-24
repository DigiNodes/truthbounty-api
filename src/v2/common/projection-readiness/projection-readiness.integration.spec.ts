import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProjectionReadinessService } from './projection-readiness.service';
import { ProjectionReadinessReason } from './projection-readiness.types';
import { V2_PROJECTORS } from './projector-registry';
import { CanonicalEvent } from '../../events/entities/canonical-event.entity';
import { ContractArtifact } from '../../events/entities/contract-artifact.entity';
import { EventQuarantine } from '../../events/entities/event-quarantine.entity';
import { QuarantineReason } from '../../events/entities/event-quarantine.entity';
import { ProjectorCursor } from '../entities/projector-cursor.entity';

const APPROVED_CONTRACT = '0x' + 'aa'.repeat(20);
const UNAPPROVED_CONTRACT = '0x' + 'bb'.repeat(20);

describe('ProjectionReadinessService (integration)', () => {
  let moduleRef: TestingModule;
  let service: ProjectionReadinessService;
  let dataSource: DataSource;

  async function seedCanonicalEvent(options: {
    eventName: string;
    blockNumber: string;
    logIndex?: number;
    contractAddress?: string;
    txHash?: string;
  }): Promise<void> {
    await dataSource.getRepository(CanonicalEvent).insert({
      chainId: 10,
      contractAddress: options.contractAddress ?? APPROVED_CONTRACT,
      artifactVersion: 'v1',
      eventName: options.eventName,
      txHash:
        options.txHash ??
        `0x${options.blockNumber.padStart(2, '0')}${'00'.repeat(30)}`,
      logIndex: options.logIndex ?? 0,
      blockNumber: options.blockNumber,
      payload: {} as object,
      rawArgs: {} as object,
    });
  }

  async function setCursor(
    projector: string,
    blockNumber: string,
    logIndex = 0,
  ): Promise<void> {
    await dataSource.getRepository(ProjectorCursor).save({
      projectorName: projector,
      lastBlockNumber: blockNumber,
      lastLogIndex: logIndex,
    });
  }

  async function seedArtifact(
    contractAddress: string,
    isApproved = true,
  ): Promise<void> {
    await dataSource.getRepository(ContractArtifact).insert({
      chainId: 10,
      contractAddress,
      artifactVersion: 'v1',
      abi: [],
      isApproved,
    });
  }

  async function seedQuarantine(contractAddress: string): Promise<void> {
    await dataSource.getRepository(EventQuarantine).insert({
      chainId: 10,
      contractAddress,
      txHash: `0x${'ff'.repeat(32)}`,
      logIndex: 0,
      blockNumber: '1',
      topic0: `0x${'11'.repeat(32)}`,
      reason: QuarantineReason.UNKNOWN_SIGNATURE,
      rawLog: { topics: [], data: '0x' },
      detail: 'topic0 matched no fragment in the approved ABI',
    });
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
            ProjectorCursor,
          ],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([
          CanonicalEvent,
          ContractArtifact,
          EventQuarantine,
          ProjectorCursor,
        ]),
      ],
      providers: [
        ProjectionReadinessService,
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();

    service = moduleRef.get(ProjectionReadinessService);
    dataSource = moduleRef.get(DataSource);
  });

  afterEach(async () => {
    await moduleRef?.close().catch(() => undefined);
  });

  it('is ready once the projector has consumed the newest handled canonical event', async () => {
    await seedCanonicalEvent({
      eventName: 'EvidenceRegistered',
      blockNumber: '100',
    });
    await seedCanonicalEvent({
      eventName: 'EvidenceReplaced',
      blockNumber: '120',
    });
    await setCursor(V2_PROJECTORS.EVIDENCE, '120');

    const readiness = await service.evaluate(V2_PROJECTORS.EVIDENCE);

    expect(readiness.ready).toBe(true);
    expect(readiness.canonicalHead).toEqual({
      blockNumber: '120',
      logIndex: 0,
    });
  });

  it('is not ready when a newer canonical event has not been projected yet', async () => {
    await seedCanonicalEvent({
      eventName: 'EvidenceRegistered',
      blockNumber: '100',
    });
    await seedCanonicalEvent({
      eventName: 'EvidenceReplaced',
      blockNumber: '120',
    });
    await setCursor(V2_PROJECTORS.EVIDENCE, '100');

    const readiness = await service.evaluate(V2_PROJECTORS.EVIDENCE);

    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual([ProjectionReadinessReason.BACKLOG]);
    expect(readiness.pendingEvents).toBe(1);
  });

  it('is not ready when the projector has no cursor while canonical events exist', async () => {
    await seedCanonicalEvent({ eventName: 'DisputeRaised', blockNumber: '50' });

    const readiness = await service.evaluate(V2_PROJECTORS.DISPUTES);

    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toContain(
      ProjectionReadinessReason.CURSOR_MISSING,
    );
  });

  it('only measures the projector against the events it is responsible for', async () => {
    // A verification event must not hold the disputes projection back: it is
    // not part of that projector's declared contract.
    await seedCanonicalEvent({
      eventName: 'VerificationRoundOpened',
      blockNumber: '900',
    });
    await seedCanonicalEvent({ eventName: 'DisputeRaised', blockNumber: '50' });
    await setCursor(V2_PROJECTORS.DISPUTES, '50');

    const readiness = await service.evaluate(V2_PROJECTORS.DISPUTES);

    expect(readiness.canonicalHead).toEqual({ blockNumber: '50', logIndex: 0 });
    expect(readiness.ready).toBe(true);
  });

  it('is not ready when an approved protocol contract has an undecodable log', async () => {
    await seedCanonicalEvent({ eventName: 'DisputeRaised', blockNumber: '50' });
    await setCursor(V2_PROJECTORS.DISPUTES, '50');
    await seedArtifact(APPROVED_CONTRACT);
    await seedQuarantine(APPROVED_CONTRACT);

    const readiness = await service.evaluate(V2_PROJECTORS.DISPUTES);

    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual([
      ProjectionReadinessReason.QUARANTINE_BACKLOG,
    ]);
    expect(readiness.quarantinedProtocolLogs).toBe(1);
  });

  it('stays ready when the quarantined log is from an address that is not protocol state', async () => {
    await seedCanonicalEvent({ eventName: 'DisputeRaised', blockNumber: '50' });
    await setCursor(V2_PROJECTORS.DISPUTES, '50');
    await seedArtifact(APPROVED_CONTRACT);
    await seedQuarantine(UNAPPROVED_CONTRACT);

    const readiness = await service.evaluate(V2_PROJECTORS.DISPUTES);

    expect(readiness.ready).toBe(true);
    expect(readiness.quarantinedProtocolLogs).toBe(0);
  });

  it('fails closed when a dependency the gate needs is degraded', async () => {
    await seedCanonicalEvent({
      eventName: 'EvidenceRegistered',
      blockNumber: '100',
    });
    await setCursor(V2_PROJECTORS.EVIDENCE, '100');

    await dataSource.query('DROP TABLE v2_event_quarantine');

    const readiness = await service.evaluate(V2_PROJECTORS.EVIDENCE);

    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual([
      ProjectionReadinessReason.EVALUATION_ERROR,
    ]);
  });

  it('assertReady rejects with 503 and the failing reasons instead of returning data', async () => {
    await seedCanonicalEvent({
      eventName: 'EvidenceRegistered',
      blockNumber: '100',
    });
    await setCursor(V2_PROJECTORS.EVIDENCE, '99');

    const error = await service
      .assertReady(V2_PROJECTORS.EVIDENCE)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      projector: 'v2-evidence',
      reasons: [ProjectionReadinessReason.BACKLOG],
      pendingEvents: 1,
    });
  });

  it('evaluateAll reports every registered projector with its own verdict', async () => {
    await seedCanonicalEvent({
      eventName: 'EvidenceRegistered',
      blockNumber: '100',
    });
    await seedCanonicalEvent({
      eventName: 'DisputeRaised',
      blockNumber: '200',
    });
    await setCursor(V2_PROJECTORS.EVIDENCE, '100');

    const report = await service.evaluateAll();

    expect(report.projectors.map((p) => p.projector).sort()).toEqual([
      'v2-disputes',
      'v2-evidence',
      'v2-verification',
    ]);
    // Evidence is caught up; disputes has a canonical event it never projected.
    expect(
      report.projectors.find((p) => p.projector === 'v2-evidence')?.ready,
    ).toBe(true);
    expect(
      report.projectors.find((p) => p.projector === 'v2-disputes')?.reasons,
    ).toEqual([
      ProjectionReadinessReason.CURSOR_MISSING,
      ProjectionReadinessReason.BACKLOG,
    ]);
    expect(report.ready).toBe(false);
    expect(report.status).toBe('not_ready');
  });
});

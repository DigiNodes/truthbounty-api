import { DataSource } from 'typeorm';
import {
  ProjectVerificationRound,
  RoundType,
  RoundStatus,
} from './verification/entities/project-verification-round.entity';
import { ProjectParticipantPosition } from './verification/entities/project-participant-position.entity';
import { DataState } from './common/data-state.enum';
import {
  ProjectDispute,
  DisputeStatus,
} from './disputes/entities/project-dispute.entity';
import {
  ProjectEvidence,
  EvidenceStatus,
} from './evidence/entities/project-evidence.entity';
import { ProjectEvidenceVersion } from './evidence/entities/project-evidence-version.entity';

/**
 * V2-BE-114: proves the protocol-integrity invariants are enforced by the
 * database itself, not only by application-level TypeScript enum typing.
 *
 * SQLite (used here, in-memory) honors TypeORM's `@Check(...)` decorator by
 * emitting the same `CHECK` clause Postgres would get from the migration in
 * 1790200000000-AddV2ProtocolIntegrityCheckConstraints.ts, so this is a
 * meaningful test of the constraint itself, not a mock of it: these inserts
 * go through `.save()`, the same path application code uses, and bypass no
 * validation, so a passing "should reject" case here means the write was
 * rejected by the schema, not by a service-layer check that a bug (or a
 * different write path) could skip.
 */
describe('V2 protocol integrity: PostgreSQL/SQLite CHECK constraints', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [
        ProjectVerificationRound,
        ProjectParticipantPosition,
        ProjectDispute,
        ProjectEvidence,
        ProjectEvidenceVersion,
      ],
      synchronize: true,
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  afterEach(async () => {
    await dataSource.getRepository(ProjectEvidenceVersion).clear();
    await dataSource.getRepository(ProjectEvidence).clear();
    await dataSource.getRepository(ProjectDispute).clear();
    await dataSource.getRepository(ProjectParticipantPosition).clear();
    await dataSource.getRepository(ProjectVerificationRound).clear();
  });

  describe('v2_project_verification_round', () => {
    const baseRound = {
      roundId: '0xround1',
      claimId: '0xclaim1',
      openedAtBlock: '100',
      eventTxHash: '0xtx1',
      eventLogIndex: 0,
    };

    it('accepts a valid status/roundType/dataState/roundNumber combination', async () => {
      const repo = dataSource.getRepository(ProjectVerificationRound);
      await expect(
        repo.save(
          repo.create({
            ...baseRound,
            roundType: 'first' as unknown as RoundType,
            roundNumber: 1,
            status: 'open' as unknown as RoundStatus,
            dataState: 'observed' as unknown as DataState,
          }),
        ),
      ).resolves.toBeDefined();
    });

    it('rejects an invalid status value', async () => {
      const repo = dataSource.getRepository(ProjectVerificationRound);
      await expect(
        repo.save(
          repo.create({
            ...baseRound,
            roundType: 'first' as unknown as RoundType,
            roundNumber: 1,
            status: 'bogus-status' as unknown as RoundStatus,
            dataState: 'observed' as unknown as DataState,
          }),
        ),
      ).rejects.toThrow();
    });

    it('rejects an invalid roundType value', async () => {
      const repo = dataSource.getRepository(ProjectVerificationRound);
      await expect(
        repo.save(
          repo.create({
            ...baseRound,
            roundType: 'not-a-real-round-type' as unknown as RoundType,
            roundNumber: 1,
            status: 'open' as unknown as RoundStatus,
            dataState: 'observed' as unknown as DataState,
          }),
        ),
      ).rejects.toThrow();
    });

    it('rejects an invalid dataState value', async () => {
      const repo = dataSource.getRepository(ProjectVerificationRound);
      await expect(
        repo.save(
          repo.create({
            ...baseRound,
            roundType: 'first' as unknown as RoundType,
            roundNumber: 1,
            status: 'open' as unknown as RoundStatus,
            dataState: 'unfinalized-typo' as unknown as DataState,
          }),
        ),
      ).rejects.toThrow();
    });

    it('rejects a non-positive roundNumber', async () => {
      const repo = dataSource.getRepository(ProjectVerificationRound);
      await expect(
        repo.save(
          repo.create({
            ...baseRound,
            roundType: 'first' as unknown as RoundType,
            roundNumber: 0,
            status: 'open' as unknown as RoundStatus,
            dataState: 'observed' as unknown as DataState,
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('v2_project_dispute', () => {
    const baseDispute = {
      disputeId: '0xclaim1:0xround1',
      claimId: '0xclaim1',
      originalRoundId: '0xround1',
      eventTxHash: '0xtx2',
      eventLogIndex: 0,
    };

    it('rejects an invalid status value', async () => {
      const repo = dataSource.getRepository(ProjectDispute);
      await expect(
        repo.save(
          repo.create({
            ...baseDispute,
            status: 'made-up' as unknown as DisputeStatus,
            dataState: 'observed' as unknown as DataState,
          }),
        ),
      ).rejects.toThrow();
    });

    it('rejects an invalid dataState value', async () => {
      const repo = dataSource.getRepository(ProjectDispute);
      await expect(
        repo.save(
          repo.create({
            ...baseDispute,
            status: 'raised' as unknown as DisputeStatus,
            dataState: 'made-up' as unknown as DataState,
          }),
        ),
      ).rejects.toThrow();
    });

    it('accepts valid values', async () => {
      const repo = dataSource.getRepository(ProjectDispute);
      await expect(
        repo.save(
          repo.create({
            ...baseDispute,
            status: 'raised' as unknown as DisputeStatus,
            dataState: 'observed' as unknown as DataState,
          }),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('v2_project_participant_position', () => {
    it('rejects an invalid dataState value', async () => {
      const repo = dataSource.getRepository(ProjectParticipantPosition);
      await expect(
        repo.save(
          repo.create({
            roundId: '0xround1',
            participant: '0xabc',
            stake: '100',
            eventTxHash: '0xtx3',
            eventLogIndex: 0,
            blockNumber: '100',
            dataState: 'made-up' as unknown as DataState,
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('v2_project_evidence', () => {
    const baseEvidence = {
      evidenceId: 'ev-1',
      claimId: '0xclaim1',
      contentDigest: '0xdigest',
      lastEventBlockNumber: '100',
      lastEventLogIndex: 0,
    };

    it('rejects an invalid status value', async () => {
      const repo = dataSource.getRepository(ProjectEvidence);
      await expect(
        repo.save(
          repo.create({
            ...baseEvidence,
            status: 'bogus' as unknown as EvidenceStatus,
            currentVersion: 1,
          }),
        ),
      ).rejects.toThrow();
    });

    it('rejects a non-positive currentVersion', async () => {
      const repo = dataSource.getRepository(ProjectEvidence);
      await expect(
        repo.save(
          repo.create({
            ...baseEvidence,
            status: 'active' as unknown as EvidenceStatus,
            currentVersion: 0,
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('v2_project_evidence_version', () => {
    it('rejects a non-positive version number', async () => {
      const repo = dataSource.getRepository(ProjectEvidenceVersion);
      await expect(
        repo.save(
          repo.create({
            evidenceId: 'ev-1',
            version: 0,
            contentDigest: '0xdigest',
            eventTxHash: '0xtx4',
            eventLogIndex: 0,
            blockNumber: '100',
          }),
        ),
      ).rejects.toThrow();
    });
  });
});

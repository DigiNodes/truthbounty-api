import { ConflictException } from '@nestjs/common';
import { EventQuarantineReplayService } from './event-quarantine-replay.service';
import {
  QuarantineReason,
  QuarantineStatus,
} from './entities/event-quarantine.entity';

const row = {
  id: 'q-1',
  chainId: 11155420,
  contractAddress: '0x1111111111111111111111111111111111111111',
  txHash: `0x${'cd'.repeat(32)}`,
  logIndex: 3,
  blockNumber: '100',
  status: QuarantineStatus.OPEN,
  rawLog: { topics: [`0x${'ab'.repeat(32)}`], data: '0x1234' },
  artifactVersion: null,
};

function build(
  overrides: {
    row?: object;
    resolution?: object;
    ingest?: object;
  } = {},
) {
  const cursorRepo = {
    find: jest
      .fn()
      .mockResolvedValue([
        { projectorName: 'evidence', lastBlockNumber: '100', lastLogIndex: 5 },
      ]),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const dataSource = { getRepository: jest.fn(() => cursorRepo) };
  const quarantine = {
    getRaw: jest.fn().mockResolvedValue(overrides.row ?? { ...row }),
    markReplayed: jest.fn().mockResolvedValue(undefined),
    markReplayFailed: jest.fn().mockResolvedValue(undefined),
  };
  const artifacts = {
    clearCache: jest.fn(),
    resolveDetailed: jest.fn().mockResolvedValue(
      overrides.resolution ?? {
        status: 'ok',
        artifactVersion: '2.1.0',
        iface: {},
        abiChecksum: 'a'.repeat(64),
      },
    ),
  };
  const canonical = {
    ingest: jest
      .fn()
      .mockResolvedValue(overrides.ingest ?? { status: 'ingested', event: {} }),
  };
  const config = { get: jest.fn().mockReturnValue(90) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };

  const service = new EventQuarantineReplayService(
    dataSource as never,
    quarantine as never,
    artifacts as never,
    canonical as never,
    config as never,
    audit as never,
  );

  return { service, cursorRepo, quarantine, artifacts, canonical, audit };
}

describe('EventQuarantineReplayService (PREWAVE-BE-053)', () => {
  it('is idempotent: an already-replayed row is not re-ingested', async () => {
    const { service, canonical, quarantine } = build({
      row: {
        ...row,
        status: QuarantineStatus.REPLAYED,
        artifactVersion: '2.1.0',
      },
    });

    const result = await service.replay('q-1', {
      actorId: 'admin-1',
      reason: 'reviewed',
    });

    expect(result.status).toBe('already_replayed');
    expect(canonical.ingest).not.toHaveBeenCalled();
    expect(quarantine.markReplayed).not.toHaveBeenCalled();
  });

  it('fails closed when the raw log was not retained', async () => {
    const { service, quarantine } = build({
      row: { ...row, rawLog: { topics: [], data: null, truncated: true } },
    });

    await expect(
      service.replay('q-1', { actorId: 'admin-1', reason: 'reviewed' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(quarantine.markReplayFailed).toHaveBeenCalledWith(
      'q-1',
      'raw_log_unavailable',
    );
  });

  it('fails closed when no valid artifact exists yet', async () => {
    const { service, quarantine } = build({
      resolution: { status: 'invalid_artifact', detail: 'checksum mismatch' },
    });

    await expect(
      service.replay('q-1', { actorId: 'admin-1', reason: 'reviewed' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(quarantine.markReplayFailed).toHaveBeenCalledWith(
      'q-1',
      'artifact_invalid',
    );
  });

  it('requires the caller to acknowledge the reviewed artifact version', async () => {
    const { service, quarantine } = build();

    await expect(
      service.replay('q-1', {
        actorId: 'admin-1',
        reason: 'reviewed',
        expectedArtifactVersion: '2.0.0',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(quarantine.markReplayFailed).toHaveBeenCalledWith(
      'q-1',
      'artifact_version_mismatch',
    );
  });

  it('does not resolve a row that is still undecodable', async () => {
    const { service, quarantine, cursorRepo } = build({
      ingest: { status: 'quarantined', reason: QuarantineReason.DECODE_ERROR },
    });

    await expect(
      service.replay('q-1', { actorId: 'admin-1', reason: 'reviewed' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(quarantine.markReplayed).not.toHaveBeenCalled();
    expect(cursorRepo.update).not.toHaveBeenCalled();
  });

  it('replays once, rewinds projectors and scrubs the row', async () => {
    const { service, quarantine, cursorRepo, audit } = build();

    const result = await service.replay('q-1', {
      actorId: 'admin-1',
      reason: 'artifact v2.1.0 added the missing event',
      expectedArtifactVersion: '2.1.0',
    });

    expect(result).toMatchObject({
      status: 'replayed',
      canonicalStatus: 'ingested',
      artifactVersion: '2.1.0',
    });
    expect(cursorRepo.update).toHaveBeenCalledWith(
      { projectorName: 'evidence' },
      { lastBlockNumber: '100', lastLogIndex: 2 },
    );
    expect(quarantine.markReplayed).toHaveBeenCalledWith(
      'q-1',
      expect.objectContaining({
        replayedBy: 'admin-1',
        artifactVersion: '2.1.0',
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'q-1' }),
    );
  });
});

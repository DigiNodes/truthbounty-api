import { NotFoundException } from '@nestjs/common';
import { EventQuarantineService } from './event-quarantine.service';
import {
  QuarantineFailureKind,
  QuarantineReason,
  QuarantineStatus,
} from './entities/event-quarantine.entity';
import { RawLog } from './interfaces/canonical-event.interface';

function rawLog(overrides: Partial<RawLog> = {}): RawLog {
  return {
    chainId: 11155420,
    address: '0x1111111111111111111111111111111111111111',
    topics: [`0x${'ab'.repeat(32)}`],
    data: '0x1234',
    transactionHash: `0x${'cd'.repeat(32)}`,
    logIndex: 3,
    blockNumber: 100n,
    ...overrides,
  };
}

function repoMock() {
  return {
    insert: jest.fn(),
    findOne: jest.fn(),
    increment: jest.fn(),
    update: jest.fn(),
  };
}

describe('EventQuarantineService (PREWAVE-BE-053)', () => {
  it('persists bounded, privacy-safe metadata for a quarantined log', async () => {
    const repo = repoMock();
    const service = new EventQuarantineService(repo as never);

    await service.record({
      log: rawLog(),
      reason: QuarantineReason.UNKNOWN_SIGNATURE,
      failureKind: QuarantineFailureKind.UNKNOWN_TOPIC,
      detail: 'x'.repeat(2_000),
      artifactVersion: '2.0.0',
      abiChecksum: 'a'.repeat(64),
    });

    expect(repo.insert).toHaveBeenCalledTimes(1);
    const inserted = repo.insert.mock.calls[0][0];
    expect(inserted).toMatchObject({
      chainId: 11155420,
      logIndex: 3,
      topic0: `0x${'ab'.repeat(32)}`,
      reason: QuarantineReason.UNKNOWN_SIGNATURE,
      failureKind: QuarantineFailureKind.UNKNOWN_TOPIC,
      status: QuarantineStatus.OPEN,
      artifactVersion: '2.0.0',
      abiChecksum: 'a'.repeat(64),
      dataLength: 2,
      topicCount: 1,
    });
    expect(inserted.detail.length).toBe(512);
    expect(inserted.dataHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('does not retain oversized raw payloads (keeps hash and length)', async () => {
    const repo = repoMock();
    const service = new EventQuarantineService(repo as never);

    await service.record({
      log: rawLog({ data: `0x${'ab'.repeat(70 * 1024)}` }),
      reason: QuarantineReason.DECODE_ERROR,
      failureKind: QuarantineFailureKind.MALFORMED_LOG,
      detail: 'too large',
    });

    const inserted = repo.insert.mock.calls[0][0];
    expect(inserted.dataLength).toBe(70 * 1024);
    expect(inserted.rawLog).toMatchObject({ data: null, truncated: true });
    expect(inserted.rawLog.dataHash).toBe(inserted.dataHash);
  });

  it('is idempotent for a duplicate identity', async () => {
    const repo = repoMock();
    repo.insert.mockRejectedValue({ code: '23505' });
    const service = new EventQuarantineService(repo as never);

    await expect(
      service.record({
        log: rawLog(),
        reason: QuarantineReason.DECODE_ERROR,
        failureKind: QuarantineFailureKind.DECODER_FAILURE,
        detail: 'dup',
      }),
    ).resolves.toBeUndefined();
  });

  it('marks a row replayed and scrubs payload/detail', async () => {
    const repo = repoMock();
    const service = new EventQuarantineService(repo as never);
    const retentionUntil = new Date('2027-01-01T00:00:00Z');

    await service.markReplayed('q-1', {
      replayedBy: 'admin-1',
      artifactVersion: '2.1.0',
      retentionUntil,
    });

    expect(repo.increment).toHaveBeenCalledWith(
      { id: 'q-1' },
      'replayAttempts',
      1,
    );
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'q-1' },
      expect.objectContaining({
        status: QuarantineStatus.REPLAYED,
        replayedBy: 'admin-1',
        artifactVersion: '2.1.0',
        retentionUntil,
        rawLog: null,
        detail: null,
      }),
    );
  });

  it('records a failed replay attempt without clearing state', async () => {
    const repo = repoMock();
    const service = new EventQuarantineService(repo as never);

    await service.markReplayFailed('q-2', 'artifact_version_mismatch');

    expect(repo.increment).toHaveBeenCalledWith(
      { id: 'q-2' },
      'replayAttempts',
      1,
    );
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'q-2' },
      { lastReplayErrorCode: 'artifact_version_mismatch' },
    );
  });

  it('throws NotFound for an unknown record', async () => {
    const repo = repoMock();
    repo.findOne.mockResolvedValue(null);
    const service = new EventQuarantineService(repo as never);

    await expect(service.getRaw('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

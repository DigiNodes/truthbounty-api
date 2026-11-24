import { TypeOrmFinalizedCursorStore } from './typeorm-finalized-cursor.store';

describe('TypeOrmFinalizedCursorStore', () => {
  const row = {
    chain_id: '11155420',
    release_id: 'v2.0.0-sepolia',
    deployment_block: '100',
    artifact_checksum: 'a'.repeat(64),
    observed_head: '210',
    safe_head: '205',
    finalized_head: '200',
    heads_observed_at: '2026-10-16T00:00:00.000Z',
    indexed_watermark: '150',
    watermark_block_hash: `0x${'1'.repeat(64)}`,
    watermark_updated_at: '2026-10-16T00:00:00.000Z',
  };

  function setup(queryImpl: jest.Mock) {
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: queryImpl,
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
      query: jest.fn().mockResolvedValue([row]),
    };
    return {
      store: new TypeOrmFinalizedCursorStore(dataSource as any),
      queryRunner,
      dataSource,
    };
  }

  it('locks the cursor row and maps bigint columns', async () => {
    const { store, queryRunner } = setup(jest.fn().mockResolvedValue([row]));
    const record = await store.transaction((tx) =>
      tx.lockCursor(11155420, 'v2.0.0-sepolia'),
    );
    expect(queryRunner.query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(record).toMatchObject({
      chainId: 11155420,
      deploymentBlock: 100n,
      finalizedHead: 200n,
      indexedWatermark: 150n,
    });
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalled();
  });

  it('advances the watermark only via compare-and-set on the expected value', async () => {
    const query = jest.fn().mockResolvedValue({ affected: 1, records: [] });
    const { store } = setup(query);
    const ok = await store.transaction((tx) =>
      tx.advanceWatermark(
        11155420,
        'v2.0.0-sepolia',
        150n,
        160n,
        '0xabc',
        new Date(),
      ),
    );
    expect(ok).toBe(true);
    const [sql, params, structured] = query.mock.calls[0];
    expect(sql).toContain('"indexed_watermark" = $3');
    expect(params.slice(0, 4)).toEqual([
      11155420,
      'v2.0.0-sepolia',
      '150',
      '160',
    ]);
    expect(structured).toBe(true);

    query.mockResolvedValueOnce({ affected: 0, records: [] });
    const lost = await store.transaction((tx) =>
      tx.advanceWatermark(
        11155420,
        'v2.0.0-sepolia',
        150n,
        160n,
        '0xabc',
        new Date(),
      ),
    );
    expect(lost).toBe(false);
  });

  it('rolls back and rethrows when the callback fails (effects + cursor are atomic)', async () => {
    const { store, queryRunner } = setup(jest.fn().mockResolvedValue([row]));
    await expect(
      store.transaction(async (tx) => {
        await tx.lockCursor(11155420, 'v2.0.0-sepolia');
        await tx.handle.query('INSERT INTO "v2_projections" ...');
        throw new Error('effect failed');
      }),
    ).rejects.toThrow('effect failed');
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalled();
  });

  it('inserts idempotently and reads outside a transaction', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const { store, dataSource } = setup(query);
    await store.transaction((tx) =>
      tx.insertCursor({
        chainId: 11155420,
        releaseId: 'v2.0.0-sepolia',
        deploymentBlock: 100n,
        artifactChecksum: 'a'.repeat(64),
        observedHead: null,
        safeHead: null,
        finalizedHead: null,
        headsObservedAt: null,
        indexedWatermark: 99n,
        watermarkBlockHash: null,
        watermarkUpdatedAt: new Date(),
      }),
    );
    expect(query.mock.calls[0][0]).toContain(
      'ON CONFLICT ("chain_id", "release_id") DO NOTHING',
    );
    await expect(store.read(11155420, 'v2.0.0-sepolia')).resolves.toMatchObject(
      {
        safeHead: 205n,
      },
    );
    expect(dataSource.query).toHaveBeenCalled();
  });
});

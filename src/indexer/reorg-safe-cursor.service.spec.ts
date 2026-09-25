import { IndexerCoordinate, ReorgSafeCursorService } from './reorg-safe-cursor.service';

describe('ReorgSafeCursorService', () => {
    const coordinate: IndexerCoordinate = {
        chainId: 10,
        contractAddress: '0xABC',
        blockNumber: 100n,
        blockHash: '0xcanonical',
        transactionHash: '0xtx',
        logIndex: 2,
        safeBlockNumber: 99n,
        finalizedBlockNumber: 90n,
    };

    function createService(queryResults: unknown[][] = [[], [], []]) {
        const queryRunner = {
            connect: jest.fn(),
            startTransaction: jest.fn(),
            query: jest.fn()
                .mockResolvedValueOnce(queryResults[0])
                .mockResolvedValueOnce(queryResults[1])
                .mockResolvedValueOnce(queryResults[2]),
            commitTransaction: jest.fn(),
            rollbackTransaction: jest.fn(),
            release: jest.fn(),
        };
        const dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) };
        return { service: new ReorgSafeCursorService(dataSource as any), queryRunner };
    }

    it('persists a new canonical block before advancing state', async () => {
        const { service, queryRunner } = createService();

        await service.advanceCursorAtomically(coordinate, []);

        expect(queryRunner.query.mock.calls[1][0]).toContain('INSERT INTO "v2_indexer_blocks"');
        expect(queryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('fails closed when a block hash is replaced', async () => {
        const { service, queryRunner } = createService([[{ block_hash: '0xold', status: 'canonical' }]]);

        await expect(service.advanceCursorAtomically(coordinate, [])).rejects.toThrow('Canonical block hash mismatch');
        expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
        expect(queryRunner.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO "v2_projections"'), expect.anything());
    });

    it('records removed logs idempotently', async () => {
        const { service, queryRunner } = createService();

        await service.recordRemovedLog({ ...coordinate, reason: 'rpc_removed' });

        expect(queryRunner.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO "v2_removed_logs"'),
            expect.arrayContaining([10, '0xabc', 100n, '0xcanonical']),
        );
        expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    });
});
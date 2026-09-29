// src/indexer/reorg-safe-cursor.service.ts
import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface IndexerCoordinate {
    chainId: number;
    contractAddress: string;
    blockNumber: bigint;
    blockHash: string;
    transactionHash: string;
    logIndex: number;
    safeBlockNumber: bigint;
    finalizedBlockNumber: bigint;
}

export interface RemovedLog {
    chainId: number;
    contractAddress: string;
    blockNumber: bigint;
    blockHash: string;
    transactionHash: string;
    logIndex: number;
    reason: string;
}

@Injectable()
export class ReorgSafeCursorService {
    private readonly logger = new Logger(ReorgSafeCursorService.name);

    constructor(private readonly dataSource: DataSource) {}

    async recordRemovedLog(log: RemovedLog): Promise<void> {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            await queryRunner.query(
                `INSERT INTO "v2_removed_logs"
                ("chain_id", "contract_address", "block_number", "block_hash", "transaction_hash", "log_index", "reason")
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT ("chain_id", "contract_address", "transaction_hash", "log_index")
                DO UPDATE SET "reason" = EXCLUDED."reason", "removed_at" = NOW()`,
                [
                    log.chainId,
                    log.contractAddress.toLowerCase(),
                    log.blockNumber,
                    log.blockHash,
                    log.transactionHash,
                    log.logIndex,
                    log.reason,
                ],
            );
            await queryRunner.commitTransaction();
            this.logger.warn(`Removed canonical log recorded for ${log.transactionHash}:${log.logIndex}`);
        } catch (error) {
            await queryRunner.rollbackTransaction();
            throw error;
        } finally {
            await queryRunner.release();
        }
    }

    async advanceCursorAtomically(
        coordinate: IndexerCoordinate,
        projectionUpdates: { entityType: string; entityId: string; stateData: any; version: bigint }[]
    ): Promise<void> {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const knownBlock = await queryRunner.query(
                `SELECT "block_hash", "status" FROM "v2_indexer_blocks"
                 WHERE "chain_id" = $1 AND "contract_address" = $2 AND "block_number" = $3
                 FOR UPDATE`,
                [coordinate.chainId, coordinate.contractAddress.toLowerCase(), coordinate.blockNumber],
            );

            if (knownBlock[0]?.status === 'replaced' ||
                (knownBlock[0] && knownBlock[0].block_hash !== coordinate.blockHash)) {
                await queryRunner.query(
                    `UPDATE "v2_indexer_blocks" SET "status" = 'replaced', "replaced_at" = NOW()
                     WHERE "chain_id" = $1 AND "contract_address" = $2 AND "block_number" = $3`,
                    [coordinate.chainId, coordinate.contractAddress.toLowerCase(), coordinate.blockNumber],
                );
                throw new Error(`Canonical block hash mismatch at ${coordinate.blockNumber}`);
            }

            if (!knownBlock[0]) {
                await queryRunner.query(
                    `INSERT INTO "v2_indexer_blocks"
                    ("chain_id", "contract_address", "block_number", "block_hash")
                    VALUES ($1, $2, $3, $4)`,
                    [coordinate.chainId, coordinate.contractAddress.toLowerCase(), coordinate.blockNumber, coordinate.blockHash],
                );
            }

            const cursor = await queryRunner.query(
                `SELECT "last_block_number", "block_hash", "log_index" FROM "v2_indexer_cursors"
                 WHERE "chain_id" = $1 AND "contract_address" = $2 FOR UPDATE`,
                [coordinate.chainId, coordinate.contractAddress.toLowerCase()],
            );
            const current = cursor[0];
            if (current && (BigInt(current.last_block_number) > coordinate.blockNumber ||
                (BigInt(current.last_block_number) === coordinate.blockNumber &&
                    (current.block_hash !== coordinate.blockHash || current.log_index >= coordinate.logIndex)))) {
                await queryRunner.commitTransaction();
                return;
            }

            // 1. Persist or update reorg-safe event cursor and checkpoint state
            await queryRunner.query(
                `INSERT INTO "v2_indexer_cursors" 
                ("chain_id", "contract_address", "last_block_number", "block_hash", "transaction_hash", "log_index", "safe_block_number", "finalized_block_number", "updated_at") 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                ON CONFLICT ("chain_id", "contract_address") 
                DO UPDATE SET 
                    "last_block_number" = EXCLUDED.last_block_number,
                    "block_hash" = EXCLUDED.block_hash,
                    "transaction_hash" = EXCLUDED.transaction_hash,
                    "log_index" = EXCLUDED.log_index,
                    "safe_block_number" = EXCLUDED.safe_block_number,
                    "finalized_block_number" = EXCLUDED.finalized_block_number,
                    "updated_at" = NOW()
                WHERE EXCLUDED."last_block_number" > "v2_indexer_cursors"."last_block_number"
                   OR (EXCLUDED."last_block_number" = "v2_indexer_cursors"."last_block_number"
                       AND EXCLUDED."log_index" > "v2_indexer_cursors"."log_index");`,
                [
                    coordinate.chainId,
                    coordinate.contractAddress.toLowerCase(),
                    coordinate.blockNumber,
                    coordinate.blockHash,
                    coordinate.transactionHash,
                    coordinate.logIndex,
                    coordinate.safeBlockNumber,
                    coordinate.finalizedBlockNumber,
                ]
            );

            // 2. Atomically write event-derived projections within the exact same transaction
            for (const proj of projectionUpdates) {
                await queryRunner.query(
                    `INSERT INTO "v2_projections" ("entity_type", "entity_id", "state_data", "version", "updated_at")
                    VALUES ($1, $2, $3, $4, NOW())
                    ON CONFLICT ("entity_type", "entity_id")
                    DO UPDATE SET 
                        "state_data" = EXCLUDED.state_data,
                        "version" = EXCLUDED.version,
                        "updated_at" = NOW()
                    WHERE EXCLUDED."version" > "v2_projections"."version";`,
                    [proj.entityType, proj.entityId, proj.stateData, proj.version]
                );
            }

            await queryRunner.commitTransaction();
            this.logger.log(
                `Successfully advanced cursor and persisted projections for block ${coordinate.blockNumber} on chain ${coordinate.chainId}`
            );
        } catch (error) {
            await queryRunner.rollbackTransaction();
            this.logger.error(`Failed atomic cursor advancement and projection write: ${error.message}`);
            throw new InternalServerErrorException('Indexer transaction rolled back due to error.');
        } finally {
            await queryRunner.release();
        }
    }
}
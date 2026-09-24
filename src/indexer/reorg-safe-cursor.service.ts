// src/indexer/reorg-safe-cursor.service.ts
import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';

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

@Injectable()
export class ReorgSafeCursorService {
    private readonly logger = new Logger(ReorgSafeCursorService.name);

    constructor(private readonly dataSource: DataSource) {}

    async advanceCursorAtomically(
        coordinate: IndexerCoordinate,
        projectionUpdates: { entityType: string; entityId: string; stateData: any; version: bigint }[]
    ): Promise<void> {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
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
                    "updated_at" = NOW();`,
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
                        "updated_at" = NOW();`,
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
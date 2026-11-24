import { DataSource, QueryRunner } from 'typeorm';
import {
  FinalizedCursorStore,
  FinalizedCursorTransaction,
} from './finalized-cursor.store';
import { ChainHeads, FinalizedCursorRecord } from './finalized-cursor.types';

const TABLE = '"v2_finalized_cursors"';

/**
 * PostgreSQL-backed cursor store. Every mutation runs inside one QueryRunner
 * transaction; the cursor row is locked with `FOR UPDATE` so concurrent
 * indexer instances serialize on (chain_id, release_id).
 */
export class TypeOrmFinalizedCursorStore implements FinalizedCursorStore<QueryRunner> {
  constructor(private readonly dataSource: DataSource) {}

  async transaction<T>(
    fn: (tx: FinalizedCursorTransaction<QueryRunner>) => Promise<T>,
  ): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const result = await fn(new TypeOrmCursorTransaction(queryRunner));
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async read(
    chainId: number,
    releaseId: string,
  ): Promise<FinalizedCursorRecord | null> {
    const rows = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT * FROM ${TABLE} WHERE "chain_id" = $1 AND "release_id" = $2`,
      [chainId, releaseId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }
}

class TypeOrmCursorTransaction implements FinalizedCursorTransaction<QueryRunner> {
  constructor(readonly handle: QueryRunner) {}

  async lockCursor(
    chainId: number,
    releaseId: string,
  ): Promise<FinalizedCursorRecord | null> {
    const rows = (await this.handle.query(
      `SELECT * FROM ${TABLE} WHERE "chain_id" = $1 AND "release_id" = $2 FOR UPDATE`,
      [chainId, releaseId],
    )) as Record<string, unknown>[];
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async insertCursor(record: FinalizedCursorRecord): Promise<void> {
    await this.handle.query(
      `INSERT INTO ${TABLE}
        ("chain_id", "release_id", "deployment_block", "artifact_checksum",
         "observed_head", "safe_head", "finalized_head", "heads_observed_at",
         "indexed_watermark", "watermark_block_hash", "watermark_updated_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT ("chain_id", "release_id") DO NOTHING`,
      [
        record.chainId,
        record.releaseId,
        record.deploymentBlock.toString(),
        record.artifactChecksum,
        record.observedHead?.toString() ?? null,
        record.safeHead?.toString() ?? null,
        record.finalizedHead?.toString() ?? null,
        record.headsObservedAt,
        record.indexedWatermark.toString(),
        record.watermarkBlockHash,
        record.watermarkUpdatedAt,
      ],
    );
  }

  async updateHeads(
    chainId: number,
    releaseId: string,
    heads: ChainHeads,
  ): Promise<void> {
    await this.handle.query(
      `UPDATE ${TABLE}
          SET "observed_head" = $3, "safe_head" = $4, "finalized_head" = $5,
              "heads_observed_at" = $6
        WHERE "chain_id" = $1 AND "release_id" = $2`,
      [
        chainId,
        releaseId,
        heads.observedHead.toString(),
        heads.safeHead.toString(),
        heads.finalizedHead.toString(),
        heads.observedAt,
      ],
    );
  }

  async advanceWatermark(
    chainId: number,
    releaseId: string,
    expectedWatermark: bigint,
    nextWatermark: bigint,
    blockHash: string,
    at: Date,
  ): Promise<boolean> {
    const result = await this.handle.query(
      `UPDATE ${TABLE}
          SET "indexed_watermark" = $4, "watermark_block_hash" = $5,
              "watermark_updated_at" = $6
        WHERE "chain_id" = $1 AND "release_id" = $2
          AND "indexed_watermark" = $3`,
      [
        chainId,
        releaseId,
        expectedWatermark.toString(),
        nextWatermark.toString(),
        blockHash,
        at,
      ],
      true,
    );
    return (result?.affected ?? 0) === 1;
  }
}

function toBigIntOrNull(value: unknown): bigint | null {
  return value === null || value === undefined ? null : BigInt(value as string);
}

function mapRow(row: Record<string, unknown>): FinalizedCursorRecord {
  return {
    chainId: Number(row.chain_id),
    releaseId: String(row.release_id),
    deploymentBlock: BigInt(row.deployment_block as string),
    artifactChecksum: String(row.artifact_checksum),
    observedHead: toBigIntOrNull(row.observed_head),
    safeHead: toBigIntOrNull(row.safe_head),
    finalizedHead: toBigIntOrNull(row.finalized_head),
    headsObservedAt: row.heads_observed_at
      ? new Date(row.heads_observed_at as string)
      : null,
    indexedWatermark: BigInt(row.indexed_watermark as string),
    watermarkBlockHash: (row.watermark_block_hash as string | null) ?? null,
    watermarkUpdatedAt: new Date(row.watermark_updated_at as string),
  };
}
